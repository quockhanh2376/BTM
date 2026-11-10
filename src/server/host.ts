import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { effectiveSeats, type Store } from '../store/db.ts';
import type { Runner, TurnOutput } from '../runner/run.ts';
import type { HostApi } from './http.ts';
import { runSession, resumeSession } from '../core/session.ts';
import { directPrompt } from '../core/prompts.ts';
import { git, commitAll } from '../git.ts';
import {
  snapshotTurn,
  guardStoredAgentTurn,
  recoverInterruptedTurn,
  restoreTicketFilesFromBase,
} from '../core/guard.ts';
import { acquireLock } from '../cli.ts';
import { inboxPath } from './inbox.ts';
import { approveGoal as approveGoalFn, type ApproveGoalResult } from '../ticket/goal.ts';
import { createMonitor } from '../energy/monitor.ts';
import { readEnergy } from '../energy/quota.ts';
import { checkLogin } from '../energy/login.ts';

export interface HostDeps {
  cfg: Config;
  store: Store;
  runner: Runner;
  logDir: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  runSession?: typeof runSession;
  resumeSession?: typeof resumeSession;
  approveGoal?: typeof approveGoalFn;
  monitor?: ReturnType<typeof createMonitor>;
}

export function createHost(d: HostDeps): HostApi & {
  busy(): boolean;
  tick(): Promise<void>;
  whenIdle(): Promise<void>;
  setAutoApprove(enabled: boolean): void;
  setSeat(seat: Seat, agent: string): { ok: boolean; status?: number; error?: string };
  resume(): Promise<{ ok: boolean; status?: number; error?: string }>;
  monitor: ReturnType<typeof createMonitor>;
} {
  const monitor = d.monitor ?? createMonitor({
    cfg: d.cfg,
    store: d.store,
    readEnergy,
    checkLogin,
    now: () => new Date(),
    env: d.env,
  });

  let isBusy = false;
  let isStopping = false;
  let activeReleaseLock: (() => void) | null = null;
  let currentAbortController: AbortController | null = null;
  let currentTurnId: number | null = null;
  let currentQueueItemId: number | null = null;
  let currentProcessQueuePromise: Promise<void> | null = null;
  let checkedInterruptedTurn = false;
  const idleResolvers: Array<() => void> = [];

  function notifyIfIdle(): void {
    if (!isBusy && !isStopping && idleResolvers.length > 0) {
      const resolvers = [...idleResolvers];
      idleResolvers.length = 0;
      for (const res of resolvers) {
        res();
      }
    }
  }

  function whenIdle(): Promise<void> {
    if (!isBusy && !isStopping) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      idleResolvers.push(resolve);
    });
  }

  function busy(): boolean {
    if (isBusy || isStopping) {
      return true;
    }
    const lockPath = join(d.dataDir, 'btm.lock');
    if (existsSync(lockPath)) {
      try {
        const content = readFileSync(lockPath, 'utf8').trim();
        const pid = parseInt(content, 10);
        if (!isNaN(pid)) {
          process.kill(pid, 0);
          return true;
        }
      } catch (err: any) {
        if (err?.code === 'EPERM') {
          return true;
        }
      }
    }
    return false;
  }

  function isExternalLockHeld(): boolean {
    if (activeReleaseLock !== null) {
      return false;
    }
    const lockPath = join(d.dataDir, 'btm.lock');
    if (existsSync(lockPath)) {
      try {
        const content = readFileSync(lockPath, 'utf8').trim();
        const pid = parseInt(content, 10);
        if (!isNaN(pid)) {
          process.kill(pid, 0);
          return true;
        }
      } catch (err: any) {
        if (err?.code === 'EPERM') {
          return true;
        }
      }
    }
    return false;
  }

  async function processQueue(): Promise<void> {
    if (isBusy || isStopping || isExternalLockHeld()) {
      return;
    }

    const item = d.store.nextQueued();
    if (!item && checkedInterruptedTurn) {
      return;
    }

    const release = acquireLock(d.dataDir);
    if (!release) {
      return;
    }

    if (!checkedInterruptedTurn) {
      checkedInterruptedTurn = true;
      const activeProject = d.store.getActiveProject();
      if (activeProject && recoverInterruptedTurn(d.store, activeProject)) {
        console.log('recovered_interrupted_turn');
      }
    }

    if (!item) {
      release();
      return;
    }

    isBusy = true;
    activeReleaseLock = release;
    const abortController = new AbortController();
    currentAbortController = abortController;
    currentQueueItemId = item.id;

    let sessionId: number | null = null;
    let createdSessionForTurn = false;

    try {
      d.store.setQueueStatus(item.id, 'running');
      const activeProject = d.store.getActiveProject();
      if (!activeProject) {
        d.store.setQueueStatus(item.id, 'cancelled');
        return;
      }

      sessionId = d.store.createSession(['Direct command'], activeProject);
      createdSessionForTurn = true;

      const taskId = `CMD-${item.id}`;
      const seats = effectiveSeats(d.cfg, d.store);
      const agent = Object.hasOwn(seats, item.to) ? seats[item.to as Seat] : '';
      const turnId = d.store.startTurn(sessionId, item.to, agent, taskId);
      currentTurnId = turnId;

      mkdirSync(d.logDir, { recursive: true });
      const logFile = join(d.logDir, `turn-${turnId}.log`);
      d.store.setTurnLog(turnId, logFile);

      let turnResult: 'done' | 'error' = 'error';

      if (item.to === 'dev' || item.to === 'qc') {
        let currentBranch = '';
        try {
          currentBranch = git(activeProject, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
        } catch (err: any) {
          d.store.endTurn(turnId, 'error', `git_error: ${err?.message || String(err)}`);
          d.store.recordHandoffFailure(sessionId, taskId, 'git_error');
          d.store.setSessionStatus(sessionId, 'error');
          d.store.setQueueStatus(item.id, 'cancelled');
          return;
        }

        const protectedBranch = d.cfg.git.protected_branch || 'main';
        const goalMatch = currentBranch.match(/^goal\/G(\d+)(?:-.*)?$/);
        const isGoalBranch = Boolean(goalMatch) && currentBranch !== protectedBranch;

        if (!isGoalBranch) {
          d.store.endTurn(turnId, 'error', 'direct_cmd_needs_goal_branch');
          d.store.recordHandoffFailure(sessionId, taskId, 'direct_cmd_needs_goal_branch');
          d.store.setSessionStatus(sessionId, 'error');
          d.store.setQueueStatus(item.id, 'cancelled');
          return;
        }

        const goalN = goalMatch![1];

        if (
          item.to === 'dev' &&
          d.store
            .listTickets(activeProject, `G${goalN}`)
            .some(
              (ticket) =>
                ticket.state === 'in_dev' ||
                ticket.state === 'returned' ||
                ticket.state === 'awaiting_qc' ||
                (ticket.state !== 'passed' && ticket.state !== 'cancelled' && Boolean(ticket.base_sha))
            )
        ) {
          d.store.endTurn(turnId, 'error', 'direct_cmd_ticket_in_progress');
          d.store.recordHandoffFailure(sessionId, taskId, 'direct_cmd_ticket_in_progress');
          d.store.setSessionStatus(sessionId, 'error');
          d.store.setQueueStatus(item.id, 'cancelled');
          return;
        }

        const dirtyCheck = git(activeProject, 'status', '--porcelain').trim();
        if (dirtyCheck.length > 0) {
          d.store.endTurn(turnId, 'error', 'dirty_tree');
          d.store.recordHandoffFailure(sessionId, taskId, 'dirty_tree');
          d.store.setSessionStatus(sessionId, 'error');
          d.store.setQueueStatus(item.id, 'cancelled');
          return;
        }

        let gateFailedReason: string | null = null;
        if (monitor && agent) {
          try {
            await monitor.refresh([agent]);
          } catch {
            // refresh reject -> coi như unknown
          }
          const gateCheck = monitor.gate(agent);
          if (!gateCheck.ok) {
            gateFailedReason = gateCheck.reason;
          }
        }

        if (gateFailedReason) {
          d.store.endTurn(turnId, 'error', gateFailedReason);
          d.store.recordHandoffFailure(sessionId, taskId, gateFailedReason);
          d.store.setQueueStatus(item.id, 'done');
          turnResult = 'error';
        } else {
          const snapshot = snapshotTurn(
            activeProject,
            currentBranch,
            protectedBranch,
            d.store,
            item.to
          );
          const author = { name: agent, email: `${agent}@btm.local` };

          if (item.to === 'dev') {
            const prompt = directPrompt('dev', item.text, d.cfg.runner.agy_allow_commands);
            let output: TurnOutput | null = null;
            let runError: any = null;
            try {
              output = await d.runner('dev', agent, prompt, activeProject, logFile, {
                signal: abortController.signal,
              });
            } catch (err: any) {
              runError = err;
            }

            const isAbort = abortController.signal.aborted || runError?.name === 'AbortError';

            if (runError) {
              const reason = isAbort ? 'aborted' : (runError?.message || String(runError));
              d.store.endTurn(turnId, 'error', reason);
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'dev', {
                isErrorOrTimeoutOrAbort: true,
                taskId,
                author,
                reason,
              });
              d.store.setQueueStatus(item.id, isAbort ? 'cancelled' : 'done');
              turnResult = 'error';
              if (createdSessionForTurn && sessionId !== null) {
                d.store.setSessionStatus(sessionId, isAbort ? 'stopped' : 'error');
              }
              return;
            }

            if (isAbort) {
              d.store.endTurn(turnId, 'error', 'aborted');
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'dev', {
                isErrorOrTimeoutOrAbort: true,
                taskId,
                author,
                reason: 'aborted',
              });
              d.store.setQueueStatus(item.id, 'cancelled');
              if (createdSessionForTurn && sessionId !== null) {
                d.store.setSessionStatus(sessionId, 'stopped');
              }
              return;
            }

            if (output!.timedOut) {
              d.store.endTurn(turnId, 'timeout', 'timeout');
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'dev', {
                isErrorOrTimeoutOrAbort: true,
                taskId,
                author,
                reason: 'timeout',
              });
              d.store.setQueueStatus(item.id, 'done');
              turnResult = 'error';
            } else if (output!.exitCode !== 0) {
              const reason = `exit_${output!.exitCode}`;
              d.store.endTurn(turnId, 'error', reason);
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'dev', {
                isErrorOrTimeoutOrAbort: true,
                taskId,
                author,
                reason,
              });
              d.store.setQueueStatus(item.id, 'done');
              turnResult = 'error';
            } else {
              const guardRes = guardStoredAgentTurn(d.store, activeProject, snapshot, 'dev');

              if (guardRes.modifiedProtectedBranch) {
                d.store.endTurn(turnId, 'error', 'agent_modified_protected_branch');
                d.store.recordHandoffFailure(sessionId, taskId, 'agent_modified_protected_branch');
                d.store.setQueueStatus(item.id, 'done');
                turnResult = 'error';
              } else if (guardRes.switchedBranch) {
                d.store.endTurn(turnId, 'error', 'agent_switched_branch');
                d.store.recordHandoffFailure(sessionId, taskId, 'agent_switched_branch');
                d.store.setQueueStatus(item.id, 'done');
                turnResult = 'error';
              } else {
                restoreTicketFilesFromBase(activeProject, snapshot.preHead);
                let commitError: string | null = null;
                const commitMsg = `G${goalN}: cmd ${item.id}: ${item.text.slice(0, 60)}`;
                try {
                  commitAll(activeProject, commitMsg, author);
                } catch (err: any) {
                  commitError = err?.message || String(err);
                }

                if (commitError) {
                  d.store.endTurn(turnId, 'error', `commit_failed: ${commitError}`);
                  try {
                    appendFileSync(logFile, `\ncommitAll failed: ${commitError}\n`);
                  } catch {}
                  d.store.setQueueStatus(item.id, 'done');
                  turnResult = 'error';
                } else {
                  const devNote =
                    guardRes.ignoredListFailed
                      ? 'ignored_list_failed'
                      : (guardRes.ignoredCleanedCount ?? 0) > 0
                      ? `ignored_cleaned:${guardRes.ignoredCleanedCount}`
                      : undefined;
                  d.store.endTurn(turnId, 'ok', devNote);
                  d.store.setQueueStatus(item.id, 'done');
                  turnResult = 'done';
                }
              }
            }
          } else if (item.to === 'qc') {
            const prompt = directPrompt('qc', item.text, d.cfg.runner.agy_allow_commands);
            let output: TurnOutput | null = null;
            let runError: any = null;
            try {
              output = await d.runner('qc', agent, prompt, activeProject, logFile, {
                signal: abortController.signal,
              });
            } catch (err: any) {
              runError = err;
            }

            const isAbort = abortController.signal.aborted || runError?.name === 'AbortError';

            if (runError) {
              const reason = isAbort ? 'aborted' : (runError?.message || String(runError));
              d.store.endTurn(turnId, 'error', reason);
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'qc', {
                isErrorOrTimeoutOrAbort: true,
              });
              d.store.setQueueStatus(item.id, isAbort ? 'cancelled' : 'done');
              turnResult = 'error';
              if (createdSessionForTurn && sessionId !== null) {
                d.store.setSessionStatus(sessionId, isAbort ? 'stopped' : 'error');
              }
              return;
            }

            if (isAbort) {
              d.store.endTurn(turnId, 'error', 'aborted');
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'qc', {
                isErrorOrTimeoutOrAbort: true,
              });
              d.store.setQueueStatus(item.id, 'cancelled');
              if (createdSessionForTurn && sessionId !== null) {
                d.store.setSessionStatus(sessionId, 'stopped');
              }
              return;
            }

            if (output!.lastMessage) {
              try {
                appendFileSync(logFile, `\n${output!.lastMessage}\n`);
              } catch {}
            }

            if (output!.timedOut) {
              d.store.endTurn(turnId, 'timeout', 'timeout');
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'qc', {
                isErrorOrTimeoutOrAbort: true,
              });
              turnResult = 'error';
            } else if (output!.exitCode !== 0) {
              const reason = `exit_${output!.exitCode}`;
              d.store.endTurn(turnId, 'error', reason);
              guardStoredAgentTurn(d.store, activeProject, snapshot, 'qc', {
                isErrorOrTimeoutOrAbort: true,
              });
              turnResult = 'error';
            } else {
              const guardRes = guardStoredAgentTurn(d.store, activeProject, snapshot, 'qc');

              if (guardRes.modifiedProtectedBranch) {
                d.store.endTurn(turnId, 'error', 'agent_modified_protected_branch');
                d.store.recordHandoffFailure(sessionId, taskId, 'agent_modified_protected_branch');
                turnResult = 'error';
              } else if (guardRes.switchedBranch) {
                d.store.endTurn(turnId, 'error', 'agent_switched_branch');
                d.store.recordHandoffFailure(sessionId, taskId, 'agent_switched_branch');
                turnResult = 'error';
              } else if (guardRes.headChanged || guardRes.treeDirty) {
                d.store.endTurn(turnId, 'error', 'qc_modified_repo');
                d.store.recordHandoffFailure(sessionId, taskId, 'qc_modified_repo');
                turnResult = 'error';
              } else {
                const qcNote =
                  guardRes.ignoredListFailed
                    ? 'ignored_list_failed'
                    : (guardRes.ignoredCleanedCount ?? 0) > 0
                    ? `ignored_cleaned:${guardRes.ignoredCleanedCount}`
                    : undefined;
                d.store.endTurn(turnId, 'ok', qcNote);
                turnResult = 'done';
              }
            }
            d.store.setQueueStatus(item.id, 'done');
          }
        }
      }

      if (createdSessionForTurn && sessionId !== null) {
        const currentSession = d.store.getSession(sessionId);
        if (currentSession?.status !== 'stopped') {
          d.store.setSessionStatus(sessionId, turnResult);
        }
      }
    } catch (err: any) {
      const isAbort = abortController.signal.aborted || err?.name === 'AbortError';
      if (currentTurnId !== null) {
        try {
          d.store.endTurn(currentTurnId, 'error', isAbort ? 'aborted' : (err?.message || String(err)));
        } catch {}
      }
      if (createdSessionForTurn && sessionId !== null) {
        try {
          const currentSession = d.store.getSession(sessionId);
          if (currentSession?.status !== 'stopped') {
            d.store.setSessionStatus(sessionId, isAbort ? 'stopped' : 'error');
          }
        } catch {}
      }
      d.store.setQueueStatus(item.id, isAbort ? 'cancelled' : 'done');
    } finally {
      currentTurnId = null;
      currentQueueItemId = null;
      if (activeReleaseLock === release) {
        release();
        activeReleaseLock = null;
      }
      if (currentAbortController === abortController) {
        currentAbortController = null;
      }
      isBusy = false;
      isStopping = false;
      // Continue draining queue
      void tick();
      if (!isBusy) {
        notifyIfIdle();
      }
    }
  }

  function getAutoApprove(): boolean {
    const setting = d.store.getSetting('auto_approve');
    if (setting !== null) {
      return setting === 'true';
    }
    return !d.cfg.session.require_task_approval;
  }

  function setAutoApprove(enabled: boolean): void {
    d.store.setSetting('auto_approve', String(enabled));
  }

  async function start(
    goals: string[],
    opts?: {
      noteId?: number;
      text?: string;
      image?: { ext: string; bytes: Buffer };
      note?: { noteId: number; text: string; image?: { ext: string; bytes: Buffer } };
      prepare?: () => Promise<{ noteId?: number } | void> | { noteId?: number } | void;
    }
  ): Promise<{ ok: boolean; error?: string }> {
    if (isStopping) {
      return { ok: false, error: 'Đang dừng phiên' };
    }
    if (busy()) {
      return { ok: false, error: 'Đang có phiên chạy' };
    }

    const activeProject = d.store.getActiveProject();
    if (!activeProject) {
      return { ok: false, error: 'Chưa có dự án active' };
    }

    const release = acquireLock(d.dataDir);
    if (!release) {
      return { ok: false, error: 'Đang có phiên chạy' };
    }

    isBusy = true;
    activeReleaseLock = release;

    let effectiveNoteId = opts?.noteId ?? opts?.note?.noteId;
    if (opts?.prepare) {
      try {
        const prepResult = await opts.prepare();
        if (prepResult && typeof prepResult === 'object' && prepResult.noteId) {
          effectiveNoteId = prepResult.noteId;
          goals = goals.map((g) => g.replace('N-?', `N-${prepResult.noteId}`));
        }
      } catch (err: any) {
        if (activeReleaseLock === release) {
          release();
          activeReleaseLock = null;
        }
        isBusy = false;
        notifyIfIdle();
        return { ok: false, error: err?.message || String(err) };
      }
    }

    const abortController = new AbortController();
    currentAbortController = abortController;

    const sessionFn = d.runSession ?? runSession;
    try {
      mkdirSync(d.logDir, { recursive: true });
    } catch (err: any) {
      if (activeReleaseLock === release) {
        release();
        activeReleaseLock = null;
      }
      if (currentAbortController === abortController) {
        currentAbortController = null;
      }
      isBusy = false;
      isStopping = false;
      notifyIfIdle();
      return { ok: false, error: err?.message || String(err) };
    }

    const approved = getAutoApprove();
    const effectiveText = opts?.note?.text ?? opts?.text;
    const effectiveImage = opts?.note?.image ?? opts?.image;

    (async () => {
      try {
        await sessionFn(
          {
            cfg: d.cfg,
            store: d.store,
            runner: d.runner,
            repo: activeProject,
            env: d.env,
            logDir: d.logDir,
            signal: abortController.signal,
            gate: monitor.gate,
            refresh: monitor.refresh,
            monitor,
          },
          goals,
          {
            approved,
            noteId: effectiveNoteId,
            text: effectiveText,
            image: effectiveImage,
            note: effectiveNoteId
              ? {
                  noteId: effectiveNoteId,
                  text: effectiveText ?? '',
                  image: effectiveImage,
                }
              : undefined,
          }
        );
      } catch {
        // Any error is captured by session outcome
      } finally {
        if (activeReleaseLock === release) {
          release();
          activeReleaseLock = null;
        }
        if (currentAbortController === abortController) {
          currentAbortController = null;
        }
        isBusy = false;
        isStopping = false;
        void tick();
        if (!isBusy) {
          notifyIfIdle();
        }
      }
    })();

    return { ok: true };
  }

  async function approve(): Promise<{ ok: boolean; error?: string }> {
    if (isStopping) {
      return { ok: false, error: 'Đang dừng phiên' };
    }
    if (busy()) {
      return { ok: false, error: 'Đang có phiên chạy' };
    }

    const activeProject = d.store.getActiveProject();
    if (!activeProject) {
      return { ok: false, error: 'Chưa có dự án active' };
    }

    const latestAwaiting = d.store.getLatestSession('awaiting_approval', activeProject);
    if (!latestAwaiting) {
      return { ok: false, error: 'Không có phiên chờ duyệt' };
    }

    const release = acquireLock(d.dataDir);
    if (!release) {
      return { ok: false, error: 'Đang có phiên chạy' };
    }

    isBusy = true;
    activeReleaseLock = release;
    const abortController = new AbortController();
    currentAbortController = abortController;

    const resumeFn = d.resumeSession ?? resumeSession;
    try {
      mkdirSync(d.logDir, { recursive: true });
    } catch (err: any) {
      if (activeReleaseLock === release) {
        release();
        activeReleaseLock = null;
      }
      if (currentAbortController === abortController) {
        currentAbortController = null;
      }
      isBusy = false;
      isStopping = false;
      notifyIfIdle();
      return { ok: false, error: err?.message || String(err) };
    }

    (async () => {
      try {
        await resumeFn(
          {
            cfg: d.cfg,
            store: d.store,
            runner: d.runner,
            repo: activeProject,
            env: d.env,
            logDir: d.logDir,
            signal: abortController.signal,
            gate: monitor.gate,
            refresh: monitor.refresh,
            monitor,
          },
          latestAwaiting.id
        );
      } catch {
        // Any error is captured by session outcome
      } finally {
        if (activeReleaseLock === release) {
          release();
          activeReleaseLock = null;
        }
        if (currentAbortController === abortController) {
          currentAbortController = null;
        }
        isBusy = false;
        isStopping = false;
        void tick();
        if (!isBusy) {
          notifyIfIdle();
        }
      }
    })();

    return { ok: true };
  }

  async function resume(): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (isStopping) {
      return { ok: false, status: 409, error: 'Đang dừng phiên' };
    }
    if (busy()) {
      return { ok: false, status: 409, error: 'Đang có phiên chạy' };
    }

    const activeProject = d.store.getActiveProject();
    if (!activeProject) {
      return { ok: false, status: 400, error: 'Chưa có dự án active' };
    }

    const latestNeedsOwner = d.store.getLatestSession('needs_owner', activeProject);
    const latestStopped = d.store.getLatestSession('stopped', activeProject);
    let target = latestNeedsOwner;
    if (!target || (latestStopped && latestStopped.id > target.id)) {
      target = latestStopped;
    }
    if (!target) {
      return { ok: false, status: 400, error: 'Không có phiên cần tiếp tục' };
    }

    const release = acquireLock(d.dataDir);
    if (!release) {
      return { ok: false, status: 409, error: 'Đang có phiên chạy' };
    }

    isBusy = true;
    activeReleaseLock = release;
    const abortController = new AbortController();
    currentAbortController = abortController;

    const resumeFn = d.resumeSession ?? resumeSession;
    try {
      mkdirSync(d.logDir, { recursive: true });
    } catch (err: any) {
      if (activeReleaseLock === release) {
        release();
        activeReleaseLock = null;
      }
      if (currentAbortController === abortController) {
        currentAbortController = null;
      }
      isBusy = false;
      isStopping = false;
      notifyIfIdle();
      return { ok: false, status: 500, error: err?.message || String(err) };
    }

    (async () => {
      try {
        await resumeFn(
          {
            cfg: d.cfg,
            store: d.store,
            runner: d.runner,
            repo: activeProject,
            env: d.env,
            logDir: d.logDir,
            signal: abortController.signal,
            gate: monitor.gate,
            refresh: monitor.refresh,
            monitor,
          },
          target.id
        );
      } catch {
        // Any error is captured by session outcome
      } finally {
        if (activeReleaseLock === release) {
          release();
          activeReleaseLock = null;
        }
        if (currentAbortController === abortController) {
          currentAbortController = null;
        }
        isBusy = false;
        isStopping = false;
        void tick();
        if (!isBusy) {
          notifyIfIdle();
        }
      }
    })();

    return { ok: true };
  }

  function stop(): { ok: boolean; error?: string } {
    if (isExternalLockHeld()) {
      return { ok: false, error: 'Phiên đang chạy từ terminal, dừng bằng Ctrl-C' };
    }

    const activeProject = d.store.getActiveProject();
    const latest = d.store.getLatestSession(undefined, activeProject ?? undefined);
    if (latest && latest.status === 'awaiting_approval') {
      d.store.setSessionStatus(latest.id, 'stopped');
    }

    if (!isBusy && !isStopping) {
      d.store.cancelQueued();
      notifyIfIdle();
      return { ok: true };
    }

    isStopping = true;
    d.store.cancelQueued();

    if (currentAbortController) {
      currentAbortController.abort();
    }

    if (currentQueueItemId !== null) {
      try {
        d.store.setQueueStatus(currentQueueItemId, 'cancelled');
      } catch {}
      currentQueueItemId = null;
    }

    if (currentTurnId !== null) {
      try {
        d.store.endTurn(currentTurnId, 'error', 'aborted');
      } catch {}
      currentTurnId = null;
    }

    if (latest && (latest.status === 'running' || latest.status === 'awaiting_approval')) {
      d.store.setSessionStatus(latest.id, 'stopped');
      const turns = d.store.listTurns(latest.id);
      const runningTurn = turns.find((t) => t.ended_at === null);
      if (runningTurn) {
        try {
          d.store.endTurn(runningTurn.id, 'error', 'aborted');
        } catch {}
      }
    }

    return { ok: true };
  }

  async function command(
    to: Seat | 'team',
    text: string
  ): Promise<{ ok: boolean; id?: number; error?: string }> {
    if (isStopping) {
      return { ok: false, error: 'Đang dừng' };
    }

    const validSeats = [...Object.keys(effectiveSeats(d.cfg, d.store)), 'team'];
    if (!validSeats.includes(to)) {
      return { ok: false, error: 'Người nhận không hợp lệ' };
    }

    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 2000) {
      return { ok: false, error: 'Độ dài lệnh phải từ 1 đến 2000 ký tự' };
    }

    if (to === 'pm') {
      return await start([trimmed]);
    }

    if (to === 'team') {
      const activeProject = d.store.getActiveProject();
      if (!activeProject) {
        return { ok: false, error: 'Chưa có dự án active' };
      }
      if (busy()) {
        return { ok: false, error: 'Đang có phiên chạy' };
      }

      try {
        inboxPath(activeProject, 'N-0');
      } catch (err: any) {
        return { ok: false, error: err?.message || 'team/inbox must be inside project' };
      }

      const createdNoteId = d.store.createNote(activeProject, trimmed, null);
      const goal = `Xử lý ghi chú team N-${createdNoteId}: ${trimmed.slice(0, 200)}`;
      const result = await start([goal], {
        noteId: createdNoteId,
        text: trimmed,
        note: { noteId: createdNoteId, text: trimmed },
      });
      if (!result.ok) {
        try {
          d.store.deleteNote(createdNoteId);
        } catch {}
      }
      return result;
    }

    const id = d.store.enqueue(to as Seat, trimmed);
    void tick();
    return { ok: true, id };
  }

  async function tick(): Promise<void> {
    if (currentProcessQueuePromise) {
      await currentProcessQueuePromise;
      return;
    }
    if (isBusy || isStopping) {
      return;
    }
    currentProcessQueuePromise = processQueue().finally(() => {
      currentProcessQueuePromise = null;
    });
    await currentProcessQueuePromise;
  }

  function setSeat(
    seat: Seat,
    agent: string
  ): { ok: boolean; status?: number; error?: string } {
    if (busy()) {
      return { ok: false, status: 409, error: 'Đang có phiên/lượt chạy' };
    }
    if (!seat || typeof seat !== 'string' || !Object.hasOwn(d.cfg.seats, seat)) {
      return {
        ok: false,
        status: 400,
        error: `Ghế "${seat}" không hợp lệ`,
      };
    }
    if (!agent || typeof agent !== 'string' || !Object.hasOwn(d.cfg.agents, agent)) {
      return {
        ok: false,
        status: 400,
        error: `Agent "${agent}" không thể ngồi ghế "${seat}"`,
      };
    }
    const agentCfg = d.cfg.agents[agent];
    if (!agentCfg || !agentCfg.can_sit.includes(seat)) {
      return {
        ok: false,
        status: 400,
        error: `Agent "${agent}" không thể ngồi ghế "${seat}"`,
      };
    }
    const current = effectiveSeats(d.cfg, d.store)[seat];
    d.store.setSetting(`seat:${seat}`, agent);
    console.log(`Đổi ghế ${seat}: ${current} → ${agent}`);
    return { ok: true };
  }

  function approveGoal(n: number): ApproveGoalResult {
    if (busy()) {
      return { ok: false, code: 'busy', message: 'Phiên/lượt đang chạy' };
    }
    const activeProject = d.store.getActiveProject();
    if (!activeProject) {
      return { ok: false, code: 'not_ready', message: 'Chưa có dự án active' };
    }
    const fn = d.approveGoal ?? approveGoalFn;
    return fn(d.store, activeProject, d.cfg, n);
  }

  return {
    start,
    approve,
    approveGoal,
    resume,
    stop,
    command,
    busy,
    tick,
    whenIdle,
    setAutoApprove,
    setSeat,
    monitor,
  };
}
