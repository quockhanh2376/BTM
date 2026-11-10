import { join } from 'node:path';
import { wrapForWorker } from '../isolation/worker.ts';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import type { ProcResult } from '../runner/run.ts';
import { runProcess } from '../runner/run.ts';
import { readEnergy, type EnergyReading, type EnergyWindow } from './quota.ts';
import { checkLogin, type LoginHealth } from './login.ts';

export interface MonitorDeps {
  cfg: Config;
  store: Store;
  readEnergy: typeof readEnergy;
  checkLogin: typeof checkLogin;
  now: () => Date;
  run?: (argv: string[]) => Promise<ProcResult>;
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
}

export function formatHHmm(iso: string): string {
  if (!iso) return '';
  const m = iso.match(/T(\d{2}:\d{2})/);
  if (m) return m[1];
  const d = new Date(iso);
  if (!isNaN(d.getTime())) {
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  return '';
}

export function createMonitor(d: MonitorDeps): {
  refresh(agents: string[], force?: boolean): Promise<void>;
  gate(agent: string): { ok: true } | { ok: false; reason: string };
} {
  const env = d.env ?? process.env;
  const worker = d.cfg.host.worker_user;
  // Cách ly: CLI đăng nhập dưới btm-worker → đọc Energy/đăng nhập cũng chạy dưới worker (wrapper, cwd projects_root).
  const runner =
    d.run ??
    ((argv: string[]) =>
      runProcess(wrapForWorker(d.cfg, argv, d.cfg.host.projects_root), {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        logFile: '/dev/null',
        env,
      }));
  const codexHome =
    d.codexHome ??
    (worker ? `/home/${worker}/.codex` : env.CODEX_HOME || join(env.HOME || '/home/agent', '.codex'));

  const checkedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  async function refreshAgent(agent: string, force?: boolean): Promise<void> {
    const agentCfg = d.cfg.agents[agent];
    if (!agentCfg) return;

    const running = inFlight.get(agent);
    if (running) {
      await running;
      return;
    }

    const lastChecked = checkedAt.get(agent);
    const minCacheSec = force ? 30 : d.cfg.energy.cache_seconds;
    if (lastChecked !== undefined) {
      const elapsedSec = (d.now().getTime() - lastChecked) / 1000;
      if (elapsedSec < minCacheSec) {
        return;
      }
    }

    const task = (async () => {
      const energyReading = await d.readEnergy(agent, agentCfg.tool, {
        run: runner,
        codexHome,
        now: d.now,
        codexViaRun: Boolean(worker),
      });
      d.store.saveEnergy(energyReading);

      const agyQuotaOk = energyReading.status === 'fresh';
      const agyQuotaOutput = energyReading.note;

      const loginHealth = await d.checkLogin(agent, agentCfg.tool, {
        run: runner,
        env,
        cfg: d.cfg,
        now: d.now,
        agyQuotaOk,
        agyQuotaOutput,
      });
      d.store.saveLogin(loginHealth);

      checkedAt.set(agent, d.now().getTime());
    })();

    inFlight.set(agent, task);
    try {
      await task;
    } finally {
      inFlight.delete(agent);
    }
  }

  return {
    async refresh(agents: string[], force?: boolean): Promise<void> {
      const uniqueAgents = Array.from(new Set(agents));
      for (const agent of uniqueAgents) {
        await refreshAgent(agent, force);
      }
    },

    gate(agent: string): { ok: true } | { ok: false; reason: string } {
      const login = d.store.latestLogin(agent);
      if (login) {
        if (login.state === 'relogin' || login.state === 'api_key') {
          return { ok: false, reason: `login:${login.state}` };
        }
      }

      const energy = d.store.latestEnergy(agent);
      if (energy && energy.status === 'fresh' && Array.isArray(energy.windows) && energy.windows.length > 0) {
        let minWindow: EnergyWindow | null = null;
        for (const w of energy.windows) {
          if (!minWindow || w.remainingPercent < minWindow.remainingPercent) {
            minWindow = w;
          }
        }

        if (minWindow && minWindow.remainingPercent < d.cfg.energy.min_remaining_percent) {
          const hhmm = formatHHmm(minWindow.resetsAt);
          return {
            ok: false,
            reason: `energy:${minWindow.name} còn ${minWindow.remainingPercent}%, hồi lúc ${hhmm}`,
          };
        }
      }

      return { ok: true };
    },
  };
}
