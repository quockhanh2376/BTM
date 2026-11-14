import { issueTurnToken, revokeTurnToken, MB_PROXY_PORT } from '../mb/proxy.ts';
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config, Seat, Tool } from '../config.ts';
import { buildArgv } from './argv.ts';
import { agentEffort, agentModel } from '../agents/model.ts';
import { workerKillAll, workerReset, wrapForWorker } from '../isolation/worker.ts';
import { agyActiveSince, importTurn, isIsolated, readWorkerOut, STATUS_FILE, syncWorkspace, workerOutFile, workspacePath, type TurnImport } from '../isolation/trusted.ts';

export interface ProcResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Bị dừng vì không có output trong idleTimeoutMs (cũng đặt timedOut). */
  idleTimedOut?: boolean;
  /** Bị dừng vì agent không ra bước mới trong progress.idleMs (cũng đặt timedOut). */
  noProgress?: boolean;
  durationMs: number;
  output: string;
}

export function getDescendantPids(rootPid: number): number[] {
  const ppidMap = new Map<number, number[]>();
  try {
    const entries = readdirSync('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closeParenIdx = stat.lastIndexOf(')');
        if (closeParenIdx === -1) continue;
        const rest = stat.slice(closeParenIdx + 2).trimStart();
        const parts = rest.split(/\s+/);
        // parts[0] is state, parts[1] is ppid
        const ppid = parseInt(parts[1], 10);
        if (!isNaN(ppid)) {
          let children = ppidMap.get(ppid);
          if (!children) {
            children = [];
            ppidMap.set(ppid, children);
          }
          children.push(pid);
        }
      } catch {
        // Process might have terminated or unreadable
      }
    }
  } catch {
    // /proc unreadable
  }

  const descendants: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    const children = ppidMap.get(curr);
    if (children) {
      for (const child of children) {
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

export function runProcess(
  argv: string[],
  o: {
    cwd: string;
    timeoutMs: number;
    logFile: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    /** Gọi khi hết giờ/huỷ: tiến trình chạy dưới user khác (sudo) BTM không tự giết được. */
    onKill?: () => void;
    /** Plan 6 Task 6: không có byte output nào trong khoảng này → giết như hết giờ. 0/undefined = tắt. */
    idleTimeoutMs?: number;
    /** Kế hoạch 8: đo tiến độ bên ngoài output (agy -p không in gì tới khi xong). activeSince(t) = có bước mới sau t. */
    progress?: { idleMs: number; checkEveryMs: number; activeSince: (sinceMs: number) => boolean };
  }
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (argv.length === 0) {
      reject(new Error('argv must not be empty'));
      return;
    }

    const startTime = Date.now();
    try {
      mkdirSync(dirname(o.logFile), { recursive: true });
    } catch {
      // Ignore directory creation error; logStream error will be handled
    }

    let logStreamError = false;
    let logStream: ReturnType<typeof createWriteStream> | null = null;
    try {
      logStream = createWriteStream(o.logFile, { flags: 'w' });
      logStream.on('error', () => {
        logStreamError = true;
      });
    } catch {
      logStreamError = true;
    }

    let timedOut = false;
    let idleTimedOut = false;
    let noProgress = false;
    let progressTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let aborted = false;
    let killInitiated = false;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let groupCheckInterval: NodeJS.Timeout | null = null;
    let sigkillSent = false;
    let childClosed = false;
    let childCloseCode: number | null = null;
    let resolved = false;
    let streamEnded = false;
    const outputChunks: Buffer[] = [];
    const descendants = new Set<number>();

    const isPidDead = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err: any) {
        return err?.code === 'ESRCH';
      }
    };

    const isGroupDead = (pgid: number): boolean => {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch (err: any) {
        return err?.code === 'ESRCH';
      }
    };

    const areAllDead = (): boolean => {
      if (childPid && !isGroupDead(childPid)) {
        return false;
      }
      for (const pid of descendants) {
        if (!isPidDead(pid)) {
          return false;
        }
      }
      return true;
    };

    const abortListener = () => {
      aborted = true;
      killAll();
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      if (groupCheckInterval) {
        clearInterval(groupCheckInterval);
        groupCheckInterval = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (o.signal && abortListener) {
        o.signal.removeEventListener('abort', abortListener);
      }
    };

    const endLogStream = (cb: () => void) => {
      if (streamEnded) {
        cb();
        return;
      }
      streamEnded = true;
      if (logStream && !logStreamError) {
        logStream.end(() => {
          cb();
        });
        logStream.once('error', () => {
          cb();
        });
      } else {
        cb();
      }
    };

    const finish = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      endLogStream(() => {
        const durationMs = Date.now() - startTime;
        const output = Buffer.concat(outputChunks).toString('utf8');
        if (aborted) {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          (err as any).result = {
            exitCode: childCloseCode,
            timedOut,
            durationMs,
            output,
          };
          reject(err);
          return;
        }
        resolve({
          exitCode: childCloseCode,
          timedOut,
          ...(idleTimedOut ? { idleTimedOut: true } : {}),
          ...(noProgress ? { noProgress: true } : {}),
          durationMs,
          output,
        });
      });
    };

    const maybeFinish = () => {
      if (!childClosed || resolved) {
        return;
      }

      if (!timedOut && !aborted) {
        finish();
        return;
      }

      if (areAllDead()) {
        finish();
        return;
      }

      if (sigkillSent) {
        let retries = 0;
        const ensureDead = () => {
          if (areAllDead() || retries++ > 20) {
            finish();
          } else {
            setTimeout(ensureDead, 25);
          }
        };
        ensureDead();
        return;
      }

      if (!groupCheckInterval) {
        groupCheckInterval = setInterval(() => {
          if (areAllDead()) {
            finish();
          }
        }, 50);
      }
    };

    const killAll = () => {
      if (killInitiated) return;
      killInitiated = true;
      try {
        o.onKill?.();
      } catch {}

      if (childPid) {
        for (const pid of getDescendantPids(childPid)) {
          descendants.add(pid);
        }
        try {
          process.kill(-childPid, 'SIGTERM');
        } catch {}
        for (const pid of descendants) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
        }

        killTimer = setTimeout(() => {
          sigkillSent = true;
          if (childPid) {
            for (const pid of getDescendantPids(childPid)) {
              descendants.add(pid);
            }
            try {
              process.kill(-childPid, 'SIGKILL');
            } catch {}
            for (const pid of descendants) {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {}
            }
          }
          maybeFinish();
        }, 5000);
        maybeFinish();
      } else {
        maybeFinish();
      }
    };

    const child = spawn(argv[0], argv.slice(1), {
      cwd: o.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: o.env ?? process.env,
    });
    const childPid = child.pid;

    if (o.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killAll();
      }, o.timeoutMs);
    }

    const armIdle = () => {
      if (!o.idleTimeoutMs || o.idleTimeoutMs <= 0 || resolved) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        idleTimedOut = true;
        killAll();
      }, o.idleTimeoutMs);
    };
    armIdle();

    if (o.progress && o.progress.idleMs > 0) {
      const p = o.progress;
      let lastActive = startTime;
      progressTimer = setInterval(() => {
        if (resolved || killInitiated) return;
        let active = false;
        try { active = p.activeSince(lastActive); } catch { active = false; }
        const now = Date.now();
        if (active) lastActive = now;
        else if (now - lastActive >= p.idleMs) {
          timedOut = true;
          noProgress = true;
          killAll();
        }
      }, p.checkEveryMs);
    }

    if (o.signal) {
      if (o.signal.aborted) {
        abortListener();
      } else {
        o.signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    const writeLog = (chunk: Buffer) => {
      if (logStream && !logStreamError) {
        try {
          logStream.write(chunk);
        } catch {
          logStreamError = true;
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      armIdle();
      outputChunks.push(chunk);
      writeLog(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      armIdle();
      outputChunks.push(chunk);
      writeLog(chunk);
    });

    child.on('error', (err) => {
      cleanup();
      endLogStream(() => {
        reject(err);
      });
    });

    child.on('close', (code) => {
      childClosed = true;
      childCloseCode = code;
      maybeFinish();
    });
  });
}

export interface TurnOutput extends ProcResult {
  lastMessage: string;
}

export type Runner = (
  seat: Seat,
  agentId: string,
  prompt: string,
  cwd: string,
  logFile: string,
  options?: { signal?: AbortSignal; images?: string[]; account?: string; noImport?: boolean }
) => Promise<TurnOutput>;

// Plan 6 Task 7 (không cách ly): file trạng thái agent ghi không được vào commit.
function excludeStatusFile(repo: string): void {
  try {
    const f = join(repo, '.git', 'info', 'exclude');
    const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (cur.split(/\r?\n/).includes(STATUS_FILE)) return;
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}${STATUS_FILE}\n`);
  } catch {
    // không có .git (test) – bỏ qua
  }
}

export interface Isolation {
  /** Dọn cấu hình CLI agent tự cài (giữ đăng nhập) trước mỗi lượt. */
  reset: (cfg: Config, agentId: string) => void;
  sync: (cfg: Config, agentId: string, checkout: string) => void;
  importTurn: (cfg: Config, agentId: string, checkout: string) => TurnImport;
  readOut: (cfg: Config, agentId: string) => string;
  /** Kế hoạch 8: agy có ghi bước mới (thư mục brain) sau sinceMs không. */
  agyActiveSince?: (cfg: Config, agentId: string, sinceMs: number) => boolean;
}

export function makeRunner(
  cfg: Config,
  defaultSignal?: AbortSignal,
  runProc: typeof runProcess = runProcess,
  killAll: (cfg: Config, agentId: string) => void = workerKillAll,
  isolation: Isolation = {
    reset: (c, a) => workerReset(c, a),
    sync: (c, a, k) => syncWorkspace(c, a, k),
    importTurn: (c, a, k) => importTurn(c, a, k),
    readOut: (c, a) => readWorkerOut(c, a),
    agyActiveSince: (c, a, s) => agyActiveSince(c, a, s),
  },
  /** Store: model/effort chọn trên dashboard ghi đè config. */
  settings?: { getSetting(key: string): string | null } | null,
  /** Công cụ của tài khoản theo khoá (một Worker có thể dùng nhiều công cụ, 2026-11-14); không có → công cụ của Worker. */
  toolOf?: (accountKey: string) => Tool | null
): Runner {
  return async (
    seat: Seat,
    agentId: string,
    prompt: string,
    cwd: string,
    logFile: string,
    options?: { signal?: AbortSignal; images?: string[]; account?: string; noImport?: boolean }
  ): Promise<TurnOutput> => {
    const agent = cfg.agents[agentId];
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found in config`);
    }

    // Plan 7: chạy dưới user của tài khoản được chọn (khoá tài khoản; mặc định = agent id).
    const w = options?.account ?? agentId;
    // Công cụ của lượt = công cụ của TÀI KHOẢN (Finn có thể có tài khoản Antigravity). Model/effort chọn theo thẻ + công cụ.
    const tool: Tool = toolOf?.(w) ?? agent.tool;

    // Kế hoạch 8: agy đo tiến độ bằng bước mới thay cho giờ cố định: còn ra bước thì chạy tới max_minutes,
    // im idle_minutes thì cắt. Chỉ khi cách ly (đọc được thư mục agy qua worker).
    const agyProgress = tool === 'antigravity-cli' && isIsolated(cfg) && isolation.agyActiveSince ? cfg.turn.agy_progress : undefined;
    const timeoutMin = agyProgress ? agyProgress.max_minutes : cfg.turn.timeout_minutes[seat];
    const timeoutMs = timeoutMin * 60 * 1000;
    const allow = cfg.runner.agy_allow_commands;

    const absLogFile = resolve(logFile);
    mkdirSync(dirname(absLogFile), { recursive: true });
    const isolated = isIsolated(cfg);
    // Cách ly: file kết quả của CLI nằm trong thư mục riêng của worker; BTM đọc lại qua worker (không thư mục chung).
    const outFile = isolated
      ? workerOutFile(cfg, w)
      : absLogFile.endsWith('.log')
        ? absLogFile.slice(0, -4) + '.out'
        : `${absLogFile}.out`;
    // cwd = checkout tin cậy; agent chạy trong workspace riêng của mình.
    const runCwd = isolated ? workspacePath(cfg, w, cwd) : cwd;
    if (!isolated) excludeStatusFile(cwd);

    const cliArgv = buildArgv(tool, prompt, {
      seat,
      timeoutMin,
      allow,
      outFile,
      images: options?.images,
      model: agentModel(cfg, settings, agentId, tool),
      effort: agentEffort(cfg, settings, agentId, tool),
    });
    // Boss (decision 0003): agent chỉ cầm mã tạm của lượt; cổng trung gian 127.0.0.1 thay bằng key Z.ai thật.
    // shortcut: mã tạm nằm trong argv (ps thấy được khi lượt khác chạy song song) – chỉ dùng được qua cổng nội bộ trong lượt này.
    const turnToken = agent.provider === 'zai' ? issueTurnToken(timeoutMs + 5 * 60 * 1000) : null;
    const argv = turnToken ? zaiArgv(cliArgv, turnToken) : cliArgv;

    let result: ProcResult;
    try {
      if (isolated) {
        killAll(cfg, w);
        try {
          isolation.reset(cfg, w);
          isolation.sync(cfg, w, cwd);
        } catch {
          const output = '[btm] sync_failed';
          return { exitCode: 1, timedOut: false, durationMs: 0, output, lastMessage: output };
        }
      }
      result = await runProc(wrapForWorker(cfg, w, argv, runCwd), {
        cwd,
        timeoutMs,
        logFile: absLogFile,
        env: process.env,
        signal: options?.signal ?? defaultSignal,
        onKill: isolated ? () => killAll(cfg, w) : undefined,
        idleTimeoutMs: (cfg.turn.idle_minutes?.[tool] ?? 0) * 60 * 1000,
        ...(agyProgress ? {
          progress: {
            idleMs: agyProgress.idle_minutes * 60 * 1000,
            checkEveryMs: 60 * 1000,
            activeSince: (since: number) => isolation.agyActiveSince!(cfg, w, since),
          },
        } : {}),
      });
    } catch (err) {
      // Anh bấm Stop: vẫn kéo code worker đã sửa về checkout trước khi báo huỷ, để guard commit WIP (không thì lượt
      // sau sync lại workspace và mất hết việc của lượt này).
      if (isolated && !options?.noImport && err instanceof Error && err.name === 'AbortError') {
        killAll(cfg, w);
        try { isolation.importTurn(cfg, w, cwd); } catch {}
      }
      throw err;
    } finally {
      killAll(cfg, w);
      if (turnToken) revokeTurnToken(turnToken);
    }
    let lastMessage = '';
    if (result.idleTimedOut) result = { ...result, output: `${result.output}\n[btm] idle_timeout` };
    if (result.noProgress) result = { ...result, output: `${result.output}\n[btm] no_progress` };
    if (isolated) {
      try {
        // noImport (lượt hỏi chỉ đọc chạy song song, 2026-11-14): KHÔNG nhập gì về checkout – nhập sẽ ghi đè
        // code chưa commit của lượt đang chạy. Chỉ đọc câu trả lời.
        if (!options?.noImport) {
          const imp = isolation.importTurn(cfg, w, cwd);
          if (!imp.ok) result = { ...result, exitCode: result.exitCode || 1, output: `${result.output}
[btm] ${imp.reason}` };
        }
        lastMessage = isolation.readOut(cfg, w);
      } finally {
        // import/readOut chạy lệnh dưới worker: dọn mọi tiến trình chúng có thể để lại.
        killAll(cfg, w);
      }
    } else if (existsSync(outFile)) {
      try {
        lastMessage = readFileSync(outFile, 'utf8');
      } catch {
        // Fallback to output
      }
    }
    if (!lastMessage) {
      lastMessage = result.output.slice(-2000);
    }

    return {
      ...result,
      lastMessage,
    };
  };
}

/** argv của lượt Boss: env trỏ Claude Code tới cổng trung gian (btm-worker-exec chạy env -i nên phải truyền qua argv). */
export function zaiArgv(argv: string[], token: string): string[] {
  return [
    'env',
    `ANTHROPIC_BASE_URL=http://127.0.0.1:${MB_PROXY_PORT}`,
    `ANTHROPIC_AUTH_TOKEN=${token}`,
    'API_TIMEOUT_MS=3000000',
    'DISABLE_TELEMETRY=1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    // Model GLM: Claude Code không biết cỡ context → khai báo như tài liệu Z.ai (hết cảnh báo "doesn't recognize the model").
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000',
    ...argv,
  ];
}
