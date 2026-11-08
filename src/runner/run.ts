import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { buildArgv } from './argv.ts';

export interface ProcResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export function runProcess(
  argv: string[],
  o: { cwd: string; timeoutMs: number; logFile: string; env?: NodeJS.ProcessEnv }
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
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let groupCheckInterval: NodeJS.Timeout | null = null;
    let sigkillSent = false;
    let childClosed = false;
    let childCloseCode: number | null = null;
    let resolved = false;
    let streamEnded = false;
    const outputChunks: Buffer[] = [];

    const isGroupDead = (pgid: number): boolean => {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch (err: any) {
        return err?.code === 'ESRCH';
      }
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (groupCheckInterval) {
        clearInterval(groupCheckInterval);
        groupCheckInterval = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
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
        resolve({
          exitCode: childCloseCode,
          timedOut,
          durationMs,
          output,
        });
      });
    };

    const maybeFinish = () => {
      if (!childClosed || resolved) {
        return;
      }

      if (!timedOut) {
        finish();
        return;
      }

      if (childPid && isGroupDead(childPid)) {
        finish();
        return;
      }

      if (sigkillSent) {
        let retries = 0;
        const ensureDead = () => {
          if (!childPid || isGroupDead(childPid) || retries++ > 20) {
            finish();
          } else {
            setTimeout(ensureDead, 25);
          }
        };
        ensureDead();
        return;
      }

      if (!groupCheckInterval && childPid) {
        groupCheckInterval = setInterval(() => {
          if (childPid && isGroupDead(childPid)) {
            finish();
          }
        }, 50);
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
        if (childPid) {
          try {
            process.kill(-childPid, 'SIGTERM');
          } catch {
            // Process may already have terminated
          }
          killTimer = setTimeout(() => {
            sigkillSent = true;
            if (childPid) {
              try {
                process.kill(-childPid, 'SIGKILL');
              } catch {
                // Ignore
              }
            }
            maybeFinish();
          }, 5000);
          maybeFinish();
        } else {
          maybeFinish();
        }
      }, o.timeoutMs);
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
      outputChunks.push(chunk);
      writeLog(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
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

export type Runner = (seat: Seat, agentId: string, prompt: string, cwd: string) => Promise<TurnOutput>;

export function makeRunner(cfg: Config, logDir: string): Runner {
  const resolvedLogDir = resolve(logDir);

  return async (seat: Seat, agentId: string, prompt: string, cwd: string): Promise<TurnOutput> => {
    const agent = cfg.agents[agentId];
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found in config`);
    }

    const timeoutMin = cfg.turn.timeout_minutes[seat];
    const timeoutMs = timeoutMin * 60 * 1000;
    const allow = cfg.runner.agy_allow_commands;

    mkdirSync(resolvedLogDir, { recursive: true });
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const logFile = join(resolvedLogDir, `${seat}-${agentId}-${timestamp}-${rand}.log`);
    const outFile = join(resolvedLogDir, `${seat}-${agentId}-${timestamp}-${rand}.out`);

    const argv = buildArgv(agent.tool, prompt, {
      seat,
      timeoutMin,
      allow,
      outFile,
    });

    const result = await runProcess(argv, {
      cwd,
      timeoutMs,
      logFile,
      env: process.env,
    });

    let lastMessage = '';
    if (existsSync(outFile)) {
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
