import { join } from 'node:path';
import { workerUser, wrapForWorker } from '../isolation/worker.ts';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import type { ProcResult } from '../runner/run.ts';
import { runProcess } from '../runner/run.ts';
import { readEnergy, type EnergyReading, type EnergyWindow } from './quota.ts';
import { checkLogin, type LoginHealth } from './login.ts';
import { listModels, ZAI_MODELS } from '../agents/models.ts';
import { mbStatus } from '../mb/vault.ts';
import { usageLimitedKey } from '../agents/usage-limit.ts';
import { activeAccountKeys, agentOfAccount } from '../agents/accounts.ts';
import type { NotifyEvent } from '../notify/notify.ts';

export interface MonitorDeps {
  cfg: Config;
  store: Store;
  readEnergy: typeof readEnergy;
  checkLogin: typeof checkLogin;
  now: () => Date;
  run?: (argv: string[]) => Promise<ProcResult>;
  env?: NodeJS.ProcessEnv;
  codexHome?: string;
  listModels?: typeof listModels;
  /** Plan 7: tài khoản đang bật bị đăng xuất (Ok → relogin) → ntfy. */
  notify?: (ev: NotifyEvent) => void;
}

const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

export const agentModelsKey = (id: string) => `agent_models:${id}`;

export function readAgentModels(store: Pick<Store, 'getSetting'>, id: string): { at: number; models: string[] } | null {
  try {
    const v = JSON.parse(store.getSetting(agentModelsKey(id)) ?? '');
    return v && Array.isArray(v.models) && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
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
  const isolated = Boolean(d.cfg.host.worker_prefix);
  // Cách ly: CLI của mỗi agent đăng nhập dưới user riêng → đọc Energy/đăng nhập chạy dưới user đó (cwd = home của nó).
  const runnerFor = (agent: string) =>
    d.run ??
    ((argv: string[]) => {
      const user = workerUser(d.cfg, agent);
      return runProcess(wrapForWorker(d.cfg, agent, argv, user ? `/home/${user}` : d.cfg.host.projects_root), {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        logFile: '/dev/null',
        env,
        // shortcut: không killall khi hết giờ – sẽ giết luôn lượt agent đang chạy dưới cùng user; tiến trình treo
        // được dọn ở killall trước/sau lượt kế tiếp của agent đó. Nâng cấp nếu thấy check Energy treo nhiều.
      });
    });
  const codexHomeFor = (agent: string) => {
    const user = workerUser(d.cfg, agent);
    return d.codexHome ?? (user ? `/home/${user}/.codex` : env.CODEX_HOME || join(env.HOME || '/home/agent', '.codex'));
  };

  const checkedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  // Plan 7: `agent` ở đây là khoá tài khoản (default = agent id). Tài khoản đang ngủ: không chạy gì dưới user của nó.
  async function refreshAgent(agent: string, force?: boolean): Promise<void> {
    const owner = agentOfAccount(d.cfg, d.store, agent);
    const agentCfg = owner ? d.cfg.agents[owner] : undefined;
    if (!agentCfg || !activeAccountKeys(d.cfg, d.store).includes(agent)) return;

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
      if (agentCfg.provider === 'zai') {
        // Boss (decision 0003): không chạy CLI để đọc quota/đăng nhập; trạng thái lấy từ kho key.
        const st = mbStatus(d.store);
        d.store.saveEnergy({ agent, status: 'unknown', windows: [], readAt: d.now().toISOString(), note: 'Z.ai' });
        d.store.saveLogin(st.set && st.enabled
          ? { agent, state: 'ok', detail: `Z.ai key …${st.last4}` }
          : { agent, state: 'relogin', detail: st.set ? 'Boss is turned off' : 'Set Boss key on Accounts page' });
        d.store.setSetting(agentModelsKey(owner!), JSON.stringify({ at: d.now().getTime(), models: ZAI_MODELS }));
        checkedAt.set(agent, d.now().getTime());
        return;
      }
      const energyReading = await d.readEnergy(agent, agentCfg.tool, {
        run: runnerFor(agent),
        codexHome: codexHomeFor(agent),
        now: d.now,
        codexViaRun: isolated,
      });
      d.store.saveEnergy(energyReading);
      // Plan 6 Task 2: cờ "hết hạn mức tới giờ hồi" (có thể do agent in giả) được gỡ khi Energy thật còn đủ.
      if (
        energyReading.status === 'fresh' &&
        energyReading.windows.length > 0 &&
        energyReading.windows.every((w) => w.remainingPercent >= d.cfg.energy.min_remaining_percent)
      ) {
        if (d.store.getSetting(usageLimitedKey(agent))) d.store.setSetting(usageLimitedKey(agent), '');
      }

      const agyQuotaOk = energyReading.status === 'fresh';
      const agyQuotaOutput = energyReading.note;

      const loginHealth = await d.checkLogin(agent, agentCfg.tool, {
        run: runnerFor(agent),
        env,
        cfg: d.cfg,
        now: d.now,
        agyQuotaOk,
        agyQuotaOutput,
      });
      const before = d.store.latestLogin(agent)?.state;
      d.store.saveLogin(loginHealth);
      if ((before === 'ok' || before === 'expiring') && loginHealth.state === 'relogin') {
        d.notify?.({ kind: 'account_logout', project: '', notes: [agent] });
      }

      // Danh sách model cho ô chọn trên dashboard: đọc dưới user của agent, tối đa 6 giờ/lần, lỗi thì giữ bản cũ.
      if (loginHealth.state === 'ok' || loginHealth.state === 'expiring') {
        const cached = readAgentModels(d.store, owner!); // Plan 7: danh sách model theo Worker, không theo tài khoản
        if (!cached || d.now().getTime() - cached.at > MODELS_TTL_MS) {
          try {
            const models = await (d.listModels ?? listModels)(agentCfg.tool, runnerFor(agent));
            if (models.length > 0) {
              d.store.setSetting(agentModelsKey(owner!), JSON.stringify({ at: d.now().getTime(), models }));
            }
          } catch {}
        }
      }

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
            reason: `energy:${minWindow.name} ${minWindow.remainingPercent}% left, resets ${hhmm}`,
          };
        }
      }

      return { ok: true };
    },
  };
}
