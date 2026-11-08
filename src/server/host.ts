import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { Config, Seat } from '../config.ts';
import type { Store } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import type { HostApi } from './http.ts';
import { runSession, resumeSession } from '../core/session.ts';
import { devPrompt, directPrompt } from '../core/prompts.ts';
import type { TaskCard } from '../task/card.ts';
import { commitAll } from '../git.ts';
import { acquireLock } from '../cli.ts';
import { inboxPath } from './inbox.ts';
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
  monitor?: ReturnType<typeof createMonitor>;
}

export function createHost(d: HostDeps): HostApi & {
  busy(): boolean;
  tick(): Promise<void>;
  whenIdle(): Promise<void>;
  setAutoApprove(enabled: boolean): void;
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
    if (isBusy || isStopping) {
      return;
    }

    const item = d.store.nextQueued();
    if (!item) {
      return;
    }

    const release = acquireLock(d.dataDir);
    if (!release) {
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
      const agent = d.cfg.seats[item.to];
      const turnId = d.store.startTurn(sessionId, item.to, agent, taskId);
      currentTurnId = turnId;

      mkdirSync(d.logDir, { recursive: true });
      const logFile = join(d.logDir, `turn-${turnId}.log`);
      d.store.setTurnLog(turnId, logFile);

      let turnResult: 'done' | 'error' = 'error';

      let gateFailedReason: string | null = null;
      if (item.to === 'dev' || item.to === 'qc') {
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
      }

      if (gateFailedReason) {
        d.store.endTurn(turnId, 'error', gateFailedReason);
        d.store.setQueueStatus(item.id, 'done');
        turnResult = 'error';
      } else if (item.to === 'dev') {
        const author = { name: agent, email: `${agent}@btm.local` };
        try {
          commitAll(activeProject, `checkpoint before cmd ${item.id}`, author);
        } catch {}

        const prompt = directPrompt('dev', item.text, d.cfg.runner.agy_allow_commands);
        const output = await d.runner('dev', agent, prompt, activeProject, logFile, {
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) {
          d.store.endTurn(turnId, 'error', 'aborted');
          d.store.setQueueStatus(item.id, 'cancelled');
          if (createdSessionForTurn) {
            const currentSession = d.store.getSession(sessionId);
            if (currentSession?.status !== 'stopped') {
              d.store.setSessionStatus(sessionId, 'stopped');
            }
          }
          return;
        }

        if (output.timedOut) {
          d.store.endTurn(turnId, 'timeout', 'timeout');
          d.store.setQueueStatus(item.id, 'done');
          turnResult = 'error';
        } else if (output.exitCode !== 0) {
          d.store.endTurn(turnId, 'error', `exit_${output.exitCode}`);
          d.store.setQueueStatus(item.id, 'done');
          turnResult = 'error';
        } else {
          let commitError: string | null = null;
          const commitMsg = `cmd ${item.id}: ${item.text.slice(0, 60)}`;
          const author = { name: agent, email: `${agent}@btm.local` };
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
            d.store.endTurn(turnId, 'ok');
            d.store.setQueueStatus(item.id, 'done');
            turnResult = 'done';
          }
        }
      } else if (item.to === 'qc') {
        const prompt = directPrompt('qc', item.text, d.cfg.runner.agy_allow_commands);
        const output = await d.runner('qc', agent, prompt, activeProject, logFile, {
          signal: abortController.signal,
        });

        if (abortController.signal.aborted) {
          d.store.endTurn(turnId, 'error', 'aborted');
          d.store.setQueueStatus(item.id, 'cancelled');
          if (createdSessionForTurn) {
            const currentSession = d.store.getSession(sessionId);
            if (currentSession?.status !== 'stopped') {
              d.store.setSessionStatus(sessionId, 'stopped');
            }
          }
          return;
        }

        if (output.lastMessage) {
          try {
            appendFileSync(logFile, `\n${output.lastMessage}\n`);
          } catch {}
        }

        if (output.timedOut) {
          d.store.endTurn(turnId, 'timeout', 'timeout');
          turnResult = 'error';
        } else if (output.exitCode !== 0) {
          d.store.endTurn(turnId, 'error', `exit_${output.exitCode}`);
          turnResult = 'error';
        } else {
          d.store.endTurn(turnId, 'ok');
          turnResult = 'done';
        }
        d.store.setQueueStatus(item.id, 'done');
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

    const validSeats = [...Object.keys(d.cfg.seats), 'team'];
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

  return {
    start,
    approve,
    stop,
    command,
    busy,
    tick,
    whenIdle,
    setAutoApprove,
    monitor,
  };
}
