#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs, { openSync, writeSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, linkSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { loadConfig, checkForbiddenEnv, type Config } from './config.ts';
import { openStore } from './store/db.ts';
import { initProject } from './project/init.ts';
import { migrateProject } from './project/migrate.ts';
import { runSession, resumeSession, type SessionOutcome } from './core/session.ts';
import { protectedShaKey } from './core/guard.ts';
import { git } from './git.ts';
import { approveGoal } from './ticket/goal.ts';
import { makeRunner, type Runner } from './runner/run.ts';
import { createHost } from './server/host.ts';
import { createServer } from './server/http.ts';
import { createMonitor } from './energy/monitor.ts';
import { readEnergy } from './energy/quota.ts';
import { checkLogin } from './energy/login.ts';

export interface CliDeps {
  runSession?: typeof runSession;
  resumeSession?: typeof resumeSession;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  abortController?: AbortController;
  createHost?: typeof createHost;
  createServer?: typeof createServer;
}

export interface ServeOptions {
  configPath?: string;
  config?: Config;
  env?: NodeJS.ProcessEnv;
  deps?: CliDeps;
  port?: number;
  bind?: string;
}

export async function serve(
  configOrOptions?: string | ServeOptions,
  deps?: CliDeps
): Promise<http.Server> {
  let configPath = './btm.config.yaml';
  let cfg: Config | undefined;
  let effectiveEnv: NodeJS.ProcessEnv = process.env;
  let effectiveDeps: CliDeps | undefined = deps;
  let portOverride: number | undefined;
  let bindOverride: string | undefined;

  if (typeof configOrOptions === 'string') {
    configPath = configOrOptions;
    effectiveDeps = deps;
    effectiveEnv = deps?.env ?? process.env;
  } else if (configOrOptions && typeof configOrOptions === 'object') {
    configPath = configOrOptions.configPath ?? configPath;
    cfg = configOrOptions.config;
    effectiveDeps = configOrOptions.deps ?? deps;
    effectiveEnv = configOrOptions.env ?? effectiveDeps?.env ?? process.env;
    portOverride = configOrOptions.port;
    bindOverride = configOrOptions.bind;
  } else {
    effectiveDeps = deps;
    effectiveEnv = deps?.env ?? process.env;
  }

  if (!cfg) {
    cfg = loadConfig(configPath);
  }

  const forbidden = checkForbiddenEnv(effectiveEnv, cfg.login.forbidden_env);
  if (forbidden.length > 0) {
    throw new Error(`Forbidden environment variables present: ${forbidden.join(', ')}`);
  }

  const dbPath = join(cfg.host.data_dir, 'btm.db');
  const store = openStore(dbPath);

  const runner = effectiveDeps?.runner ?? makeRunner(cfg);
  const hostFactory = effectiveDeps?.createHost ?? createHost;
  const serverFactory = effectiveDeps?.createServer ?? createServer;

  const monitor = createMonitor({
    cfg,
    store,
    readEnergy,
    checkLogin,
    now: () => new Date(),
    env: effectiveEnv,
  });

  const host = hostFactory({
    cfg,
    store,
    runner,
    logDir: join(cfg.host.data_dir, 'logs'),
    dataDir: cfg.host.data_dir,
    env: effectiveEnv,
    runSession: effectiveDeps?.runSession,
    resumeSession: effectiveDeps?.resumeSession,
    monitor,
  });

  const btmRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const webFile = join(btmRoot, 'web', 'index.html');

  const server = serverFactory({
    cfg,
    store,
    host,
    webFile,
    monitor,
  });

  const bind = bindOverride ?? cfg.host.dashboard.bind ?? '127.0.0.1';
  const port = portOverride ?? cfg.host.dashboard.port;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, bind, () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  const addr = server.address() as AddressInfo | null;
  const actualPort = addr ? addr.port : port;
  console.log(`BTM dashboard: http://127.0.0.1:${actualPort}`);

  const tickTimer = setInterval(() => {
    void host.tick();
  }, 2000);

  let storeClosed = false;
  const closeStore = () => {
    if (storeClosed) return;
    storeClosed = true;
    try {
      store.close();
    } catch {}
  };

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(tickTimer);
    process.removeListener('SIGINT', sigListener);
    process.removeListener('SIGTERM', sigListener);

    const closeServerPromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    try {
      await host.stop();
    } catch {}

    if ('whenIdle' in host && typeof (host as any).whenIdle === 'function') {
      try {
        await (host as any).whenIdle();
      } catch {}
    }

    await closeServerPromise;
    closeStore();
    process.exit(0);
  };

  const sigListener = () => {
    void shutdown();
  };

  process.on('SIGINT', sigListener);
  process.on('SIGTERM', sigListener);

  server.on('close', () => {
    clearInterval(tickTimer);
    process.removeListener('SIGINT', sigListener);
    process.removeListener('SIGTERM', sigListener);
    if (!isShuttingDown) {
      closeStore();
    }
  });

  return server;
}

export function acquireLock(dataDir: string): (() => void) | null {
  const lockPath = join(dataDir, 'btm.lock');
  mkdirSync(dataDir, { recursive: true });

  const tryCreateLock = (): boolean => {
    const tmpPath = join(
      dataDir,
      `btm.lock.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
    );
    try {
      writeFileSync(tmpPath, String(process.pid));
      fs.linkSync(tmpPath, lockPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      return true;
    } catch (err: any) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      if (err?.code === 'EEXIST') {
        return false;
      }
      throw err;
    }
  };

  if (tryCreateLock()) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    };
  }

  let isAlive = false;
  let existingPid: number | null = null;
  try {
    const content = readFileSync(lockPath, 'utf8').trim();
    existingPid = parseInt(content, 10);
    if (!isNaN(existingPid)) {
      process.kill(existingPid, 0);
      isAlive = true;
    }
  } catch (killErr: any) {
    if (killErr?.code === 'EPERM') {
      isAlive = true;
    } else if (killErr?.code === 'ESRCH') {
      isAlive = false;
    }
  }

  if (isAlive) {
    return null;
  }

  // pid chết → unlink rồi thử link lại một lần
  try {
    fs.unlinkSync(lockPath);
  } catch {}

  if (tryCreateLock()) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    };
  }

  return null;
}

export async function main(
  argv?: string[],
  env?: NodeJS.ProcessEnv | CliDeps,
  deps?: CliDeps
): Promise<number | http.Server> {
  const rawArgs = argv ?? process.argv.slice(2);

  let effectiveEnv: NodeJS.ProcessEnv;
  let effectiveDeps: CliDeps | undefined;

  if (
    env &&
    ('runSession' in env ||
      'resumeSession' in env ||
      'runner' in env ||
      'abortController' in env ||
      'createHost' in env ||
      'createServer' in env)
  ) {
    effectiveDeps = env as CliDeps;
    effectiveEnv = effectiveDeps.env ?? process.env;
  } else {
    effectiveEnv = (env as NodeJS.ProcessEnv) ?? deps?.env ?? process.env;
    effectiveDeps = deps;
  }

  let parsed: {
    values: {
      config?: string;
      key?: string;
      goal?: string[];
      approved?: boolean;
      json?: boolean;
      help?: boolean;
    };
    positionals: string[];
  };

  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        config: {
          type: 'string',
          default: './btm.config.yaml',
        },
        key: {
          type: 'string',
        },
        goal: {
          type: 'string',
          multiple: true,
        },
        'goal-id': {
          type: 'string',
          multiple: true,
        },
        approved: {
          type: 'boolean',
          default: false,
        },
        json: {
          type: 'boolean',
          default: false,
        },
        help: {
          type: 'boolean',
          default: false,
        },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return 1;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];
  const configPath = (values.config as string) || './btm.config.yaml';

  if (!command || values.help || command === 'help') {
    console.log(`BTM – Bot Task Manager v1.0

Usage:
  btm init <name>                               Initialize a new project and set active
  btm migrate --key <KEY>                       Migrate an existing project to tickets workflow
  btm run --goal "<g>" [--goal …] [--approved]  Run a session on the active project
  btm status                                    Show active project and latest session status
  btm goal list                                 List goals for active project
  btm goal approve G<n>                         Approve and merge goal into main
  btm main accept                               Accept and re-pin current main branch SHA
  btm serve                                     Start dashboard HTTP server and host

Options:
  --config <path>   Config file path (default: ./btm.config.yaml)
  --key <KEY>       Project key for init or migrate (2-5 uppercase letters)
  --goal <text>     Session goal (1-3 goals)
  --approved        Approve task cards generated by PM
  --json            Output in JSON format (status command)
  --help            Show help
`);
    process.exitCode = 0;
    return 0;
  }

  if (['init', 'run', 'status', 'serve', 'goal', 'migrate', 'main'].includes(command)) {
    let cfg;
    try {
      cfg = loadConfig(configPath);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return 1;
    }

    const forbidden = checkForbiddenEnv(effectiveEnv, cfg.login.forbidden_env);
    if (forbidden.length > 0) {
      console.error(`Forbidden environment variables present: ${forbidden.join(', ')}`);
      process.exitCode = 2;
      return 2;
    }

    if (command === 'init') {
      const name = positionals[1];
      if (!name) {
        console.error('Error: Project name required. Usage: btm init <name> --key <KEY>');
        process.exitCode = 1;
        return 1;
      }

      const key = values.key;
      if (!key || typeof key !== 'string' || !/^[A-Z]{2,5}$/.test(key)) {
        console.error('Error: Project key required. Project key must match /^[A-Z]{2,5}$/. Usage: btm init <name> --key <KEY>');
        process.exitCode = 1;
        return 1;
      }

      try {
        const btmRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const templatesFrom = join(btmRoot, 'team', 'templates');

        const projectPath = initProject(cfg.host.projects_root, name, templatesFrom, { key });
        const dbPath = join(cfg.host.data_dir, 'btm.db');
        const store = openStore(dbPath);
        try {
          store.setActiveProject(projectPath);
        } finally {
          store.close();
        }

        console.log(`Initialized project "${name}" at ${projectPath}`);
        process.exitCode = 0;
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return 1;
      }
    }

    if (command === 'run') {
      let releaseLock = acquireLock(cfg.host.data_dir);
      if (!releaseLock) {
        console.error('Error: Another btm process is running.');
        process.exitCode = 1;
        return 1;
      }
      try {
        const goals: Array<string | { n: number }> = [];
        for (let i = 0; i < rawArgs.length; i++) {
          const arg = rawArgs[i];
          if (arg === '--goal' && i + 1 < rawArgs.length) {
            goals.push(rawArgs[++i]);
          } else if (arg.startsWith('--goal=')) {
            goals.push(arg.slice('--goal='.length));
          } else if (arg === '--goal-id' && i + 1 < rawArgs.length) {
            const rawId = rawArgs[++i];
            const match = rawId.match(/^G(\d+)$/);
            if (!match) {
              console.error(`Error: Invalid goal ID "${rawId}". Expected format G<n> (e.g. G1).`);
              process.exitCode = 1;
              return 1;
            }
            goals.push({ n: parseInt(match[1], 10) });
          } else if (arg.startsWith('--goal-id=')) {
            const rawId = arg.slice('--goal-id='.length);
            const match = rawId.match(/^G(\d+)$/);
            if (!match) {
              console.error(`Error: Invalid goal ID "${rawId}". Expected format G<n> (e.g. G1).`);
              process.exitCode = 1;
              return 1;
            }
            goals.push({ n: parseInt(match[1], 10) });
          }
        }
        const approved = Boolean(values.approved);

        if (goals.length === 0 && !approved) {
          console.error('Error: At least one --goal or --goal-id is required. Usage: btm run --goal "<g>" [--goal-id G<n>]');
          process.exitCode = 1;
          return 1;
        }

        const dbPath = join(cfg.host.data_dir, 'btm.db');
        const store = openStore(dbPath);

        const abortController = effectiveDeps?.abortController ?? new AbortController();
        let activeTurnId: number | null = null;
        let activeSessionId: number | null = null;

        const originalStartTurn = store.startTurn.bind(store);
        store.startTurn = (...args) => {
          const id = originalStartTurn(...args);
          activeTurnId = id;
          activeSessionId = args[0];
          return id;
        };

        const originalEndTurn = store.endTurn.bind(store);
        store.endTurn = (...args) => {
          originalEndTurn(...args);
          if (activeTurnId === args[0]) {
            activeTurnId = null;
          }
        };

        const originalCreateSession = store.createSession.bind(store);
        store.createSession = (...args) => {
          const id = originalCreateSession(...args);
          activeSessionId = id;
          return id;
        };

        const originalSetSessionStatus = store.setSessionStatus.bind(store);
        store.setSessionStatus = (...args) => {
          originalSetSessionStatus(...args);
          if (args[1] !== 'running' && args[1] !== 'pending') {
            activeSessionId = null;
          }
        };

        let stoppedHandled = false;
        const handleStop = () => {
          if (stoppedHandled) return;
          stoppedHandled = true;
          abortController.abort();
          if (activeTurnId !== null) {
            try {
              store.endTurn(activeTurnId, 'error', 'Interrupted');
            } catch {}
            activeTurnId = null;
          }
          if (activeSessionId !== null) {
            try {
              store.setSessionStatus(activeSessionId, 'stopped');
            } catch {}
          }
        };

        const sigListener = () => {
          handleStop();
          if (releaseLock) {
            releaseLock();
            releaseLock = null;
          }
          try {
            store.close();
          } catch {}
          process.exitCode = 130;
          process.exit(130);
        };

        process.on('SIGINT', sigListener);
        process.on('SIGTERM', sigListener);

        const abortListener = () => {
          handleStop();
        };
        abortController.signal.addEventListener('abort', abortListener);

        try {
          const activeProject = store.getActiveProject();

          if (!activeProject) {
            const outcome: SessionOutcome = {
              status: 'refused',
              sessionId: null,
              tasks: {},
              notes: ['No active project set. Run "btm init <name>" first.'],
            };
            console.log(JSON.stringify(outcome, null, 2));
            process.exitCode = 2;
            return 2;
          }

          if (goals.length === 0 && approved) {
            const latestAwaiting = store.getLatestSession('awaiting_approval', activeProject);
            if (!latestAwaiting) {
              console.error('Error: No session awaiting approval found to resume.');
              process.exitCode = 1;
              return 1;
            }

            activeSessionId = latestAwaiting.id;
            const runner = effectiveDeps?.runner ?? makeRunner(cfg, abortController.signal);
            const resumeFn = effectiveDeps?.resumeSession ?? resumeSession;

            const outcome = await resumeFn(
              {
                cfg,
                store,
                runner,
                repo: activeProject,
                env: effectiveEnv,
                logDir: join(cfg.host.data_dir, 'logs'),
                signal: abortController.signal,
              },
              latestAwaiting.id
            );

            console.log(JSON.stringify(outcome, null, 2));

            if (abortController.signal.aborted || outcome.status === 'stopped') {
              handleStop();
              process.exitCode = 130;
              return 130;
            }

            let exitCode = 1;
            if (outcome.status === 'done' || outcome.status === 'awaiting_approval') {
              exitCode = 0;
            } else if (outcome.status === 'refused') {
              exitCode = 2;
            } else {
              exitCode = 1;
            }

            process.exitCode = exitCode;
            return exitCode;
          }

          const runner = effectiveDeps?.runner ?? makeRunner(cfg, abortController.signal);
          const sessionFn = effectiveDeps?.runSession ?? runSession;

          const outcome = await sessionFn(
            {
              cfg,
              store,
              runner,
              repo: activeProject,
              env: effectiveEnv,
              logDir: join(cfg.host.data_dir, 'logs'),
              signal: abortController.signal,
            },
            goals,
            { approved }
          );

          console.log(JSON.stringify(outcome, null, 2));

          if (abortController.signal.aborted || outcome.status === 'stopped') {
            handleStop();
            process.exitCode = 130;
            return 130;
          }

          let exitCode = 1;
          if (outcome.status === 'done' || outcome.status === 'awaiting_approval') {
            exitCode = 0;
          } else if (outcome.status === 'refused') {
            exitCode = 2;
          } else {
            exitCode = 1;
          }

          process.exitCode = exitCode;
          return exitCode;
        } catch (err) {
          if (abortController.signal.aborted) {
            handleStop();
            process.exitCode = 130;
            return 130;
          }
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return 1;
        } finally {
          process.removeListener('SIGINT', sigListener);
          process.removeListener('SIGTERM', sigListener);
          abortController.signal.removeEventListener('abort', abortListener);
          store.close();
        }
      } finally {
        releaseLock?.();
      }
    }

    if (command === 'status') {
      const dbPath = join(cfg.host.data_dir, 'btm.db');
      const store = openStore(dbPath);
      try {
        const activeProject = store.getActiveProject();

        let lastSession: { id: number; status: string; started_at: string; ended_at: string | null } | null = null;
        try {
          const db = new Database(dbPath);
          try {
            const row = db
              .prepare('SELECT id, status, started_at, ended_at FROM sessions ORDER BY id DESC LIMIT 1')
              .get() as { id: number; status: string; started_at: string; ended_at: string | null } | undefined;
            if (row) {
              lastSession = row;
            }
          } finally {
            db.close();
          }
        } catch {
          // Table or db might not exist yet
        }

        let seatTurns = { pm: 0, dev: 0, qc: 0, total: 0 };
        if (lastSession) {
          seatTurns = {
            pm: store.countTurns(lastSession.id, 'pm'),
            dev: store.countTurns(lastSession.id, 'dev'),
            qc: store.countTurns(lastSession.id, 'qc'),
            total: store.countTurns(lastSession.id),
          };
        }

        if (values.json) {
          console.log(
            JSON.stringify(
              {
                activeProject: activeProject ?? null,
                latestSession: lastSession,
                turns: seatTurns,
              },
              null,
              2
            )
          );
        } else {
          console.log(`Active project: ${activeProject ?? '(none)'}`);
          if (lastSession) {
            console.log(`Latest session: #${lastSession.id} (${lastSession.status})`);
            console.log(
              `Turns by seat: pm=${seatTurns.pm}, dev=${seatTurns.dev}, qc=${seatTurns.qc} (total=${seatTurns.total})`
            );
          } else {
            console.log('Latest session: (none)');
            console.log('Turns by seat: pm=0, dev=0, qc=0 (total=0)');
          }
        }

        process.exitCode = 0;
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return 1;
      } finally {
        store.close();
      }
    }

    if (command === 'goal') {
      const subCommand = positionals[1];
      if (subCommand === 'list') {
        const dbPath = join(cfg.host.data_dir, 'btm.db');
        const store = openStore(dbPath);
        try {
          const activeProject = store.getActiveProject();
          if (!activeProject) {
            console.error('Error: No active project set. Run "btm init <name>" first.');
            process.exitCode = 1;
            return 1;
          }
          const goals = store.listGoals(activeProject);
          for (const g of goals) {
            const tickets = store.listTickets(activeProject, `G${g.n}`);
            const total = tickets.length;
            const passed = tickets.filter((t) => t.state === 'passed').length;
            console.log(`G${g.n} · ${g.state} · ${passed}/${total} · ${g.branch}`);
          }
          process.exitCode = 0;
          return 0;
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return 1;
        } finally {
          store.close();
        }
      }

      if (subCommand === 'approve') {
        const goalArg = positionals[2];
        if (!goalArg) {
          console.error('Error: Goal required. Usage: btm goal approve G<n>');
          process.exitCode = 1;
          return 1;
        }

        const match = goalArg.match(/^G?(\d+)$/i);
        if (!match) {
          console.error(`Error: Invalid goal "${goalArg}". Expected format G<n> (e.g. G1).`);
          process.exitCode = 1;
          return 1;
        }
        const goalNumber = parseInt(match[1], 10);

        const dbPath = join(cfg.host.data_dir, 'btm.db');
        const store = openStore(dbPath);
        try {
          const activeProject = store.getActiveProject();
          if (!activeProject) {
            console.error('Error: No active project set. Run "btm init <name>" first.');
            process.exitCode = 1;
            return 1;
          }

          const res = approveGoal(store, activeProject, cfg, goalNumber);
          if (res.ok) {
            console.log(`Goal G${goalNumber} approved and merged: ${res.sha}`);
            process.exitCode = 0;
            return 0;
          } else {
            console.error(`Error: Cannot approve goal G${goalNumber}: [${res.code}] ${res.message}`);
            process.exitCode = 1;
            return 1;
          }
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return 1;
        } finally {
          store.close();
        }
      }

      console.error(`Unknown goal subcommand: "${subCommand}". Usage: btm goal [list|approve G<n>]`);
      process.exitCode = 1;
      return 1;
    }

    if (command === 'migrate') {
      const key = values.key;
      if (!key || typeof key !== 'string' || !/^[A-Z]{2,5}$/.test(key)) {
        console.error(
          'Error: Project key required. Project key must match /^[A-Z]{2,5}$/. Usage: btm migrate --key <KEY>'
        );
        process.exitCode = 1;
        return 1;
      }

      let releaseLock = acquireLock(cfg.host.data_dir);
      if (!releaseLock) {
        console.error('Error: Another btm process is running (đang có phiên).');
        process.exitCode = 1;
        return 1;
      }

      try {
        const dbPath = join(cfg.host.data_dir, 'btm.db');
        const store = openStore(dbPath);
        try {
          const activeProject = store.getActiveProject();
          if (!activeProject) {
            console.error('Error: No active project set. Run "btm init <name>" first.');
            process.exitCode = 1;
            return 1;
          }

          const protectedBranch = cfg.git?.protected_branch || 'main';
          const res = migrateProject(activeProject, key, protectedBranch);
          if (res.already) {
            console.log(
              `Project already migrated with key "${key}". Đã chuyển sang ${protectedBranch}; nhánh cũ ${res.previousBranch} giữ nguyên.`
            );
          } else {
            console.log(
              `Migrated project "${activeProject}" with key "${key}". Đã chuyển sang ${protectedBranch}; nhánh cũ ${res.previousBranch} giữ nguyên.`
            );
          }
          process.exitCode = 0;
          return 0;
        } finally {
          store.close();
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return 1;
      } finally {
        releaseLock?.();
      }
    }

    if (command === 'main') {
      const subCommand = positionals[1];
      if (subCommand === 'accept') {
        const dbPath = join(cfg.host.data_dir, 'btm.db');
        const store = openStore(dbPath);
        try {
          const activeProject = store.getActiveProject();
          if (!activeProject) {
            console.error('Error: No active project set. Run "btm init <name>" first.');
            process.exitCode = 1;
            return 1;
          }
          const protectedBranch = cfg.git?.protected_branch || 'main';
          const protectedRef = protectedBranch.startsWith('refs/heads/')
            ? protectedBranch
            : `refs/heads/${protectedBranch}`;
          const newSha = git(activeProject, 'rev-parse', protectedRef).trim();
          const pinKey = protectedShaKey(activeProject);
          const oldSha = store.getSetting(pinKey)?.trim() || '(none)';
          store.setSetting(pinKey, newSha);
          console.log(`pin ${oldSha} → ${newSha}`);
          process.exitCode = 0;
          return 0;
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return 1;
        } finally {
          store.close();
        }
      }

      console.error(`Unknown main subcommand: "${subCommand}". Usage: btm main accept`);
      process.exitCode = 1;
      return 1;
    }

    if (command === 'serve') {
      try {
        const server = await serve(
          {
            config: cfg,
            configPath,
            env: effectiveEnv,
            deps: effectiveDeps,
          },
          effectiveDeps
        );
        return server;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return 1;
      }
    }
  }

  console.error(`Unknown command: "${command}". Run "btm --help" for usage.`);
  process.exitCode = 1;
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    if (typeof code === 'number') {
      process.exit(code);
    }
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
