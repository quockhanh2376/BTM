import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Seat } from '../config.ts';
import type { Store } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import type { HostApi } from './http.ts';
import { runSession, resumeSession } from '../core/session.ts';
import { devPrompt, directPrompt } from '../core/prompts.ts';
import type { TaskCard } from '../task/card.ts';
import { commitAll } from '../git.ts';
import { acquireLock } from '../cli.ts';

export interface HostDeps {
  cfg: Config;
  store: Store;
  runner: Runner;
  logDir: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  runSession?: typeof runSession;
  resumeSession?: typeof resumeSession;
}

export function createHost(d: HostDeps): HostApi & {
  busy(): boolean;
  tick(): Promise<void>;
  whenIdle(): Promise<void>;
} {
  let isBusy = false;
  let isStopping = false;
  let activeReleaseLock: (() => void) | null = null;
  let currentAbortController: AbortController | null = null;
  let currentTurnId: number | null = null;
  let currentQueueItemId: number | null = null;
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
    if (isBusy) {
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

      let latestSession = d.store.getLatestSession(undefined, activeProject);
      if (!latestSession) {
        const anyLatest = d.store.getLatestSession();
        if (anyLatest && (!anyLatest.project || anyLatest.project === activeProject)) {
          latestSession = anyLatest;
        }
      }

      if (latestSession && (latestSession.status === 'running' || latestSession.status === 'awaiting_approval')) {
        sessionId = latestSession.id;
      } else {
        sessionId = d.store.createSession(['Direct command'], activeProject);
        createdSessionForTurn = true;
      }

      const taskId = `CMD-${item.id}`;
      const agent = d.cfg.seats[item.to];
      const turnId = d.store.startTurn(sessionId, item.to, agent, taskId);
      currentTurnId = turnId;

      mkdirSync(d.logDir, { recursive: true });
      const logFile = join(d.logDir, `turn-${turnId}.log`);
      d.store.setTurnLog(turnId, logFile);

      let turnResult: 'done' | 'error' = 'error';

      if (item.to === 'dev') {
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
          d.store.endTurn(turnId, 'ok');
          const commitMsg = `cmd ${item.id}: ${item.text.slice(0, 60)}`;
          const author = { name: agent, email: `${agent}@btm.local` };
          try {
            commitAll(activeProject, commitMsg, author);
          } catch {
            // commitAll failure should not crash host
          }
          d.store.setQueueStatus(item.id, 'done');
          turnResult = 'done';
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

  async function start(goals: string[]): Promise<{ ok: boolean; error?: string }> {
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
          },
          goals,
          { approved: false }
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

    const activeProject = d.store.getActiveProject();
    const latest = d.store.getLatestSession(undefined, activeProject ?? undefined);
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
    to: Seat,
    text: string
  ): Promise<{ ok: boolean; id?: number; error?: string }> {
    if (to !== 'pm' && to !== 'dev' && to !== 'qc') {
      return { ok: false, error: 'Người nhận không hợp lệ' };
    }

    const trimmed = text.trim();
    if (trimmed.length < 1 || trimmed.length > 2000) {
      return { ok: false, error: 'Độ dài lệnh phải từ 1 đến 2000 ký tự' };
    }

    if (to === 'pm') {
      return await start([trimmed]);
    }

    const id = d.store.enqueue(to, trimmed);
    void tick();
    return { ok: true, id };
  }

  async function tick(): Promise<void> {
    if (isBusy || isStopping) {
      return;
    }
    await processQueue();
  }

  return {
    start,
    approve,
    stop,
    command,
    busy,
    tick,
    whenIdle,
  };
}
