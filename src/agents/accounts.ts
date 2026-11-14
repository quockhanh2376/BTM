import type { Config, Seat, Tool } from '../config.ts';
import type { Store } from '../store/db.ts';
import { READ_ONLY_SEATS } from '../runner/argv.ts';
import { usageLimitedKey } from './usage-limit.ts';

// Plan 7: Worker (agent) có nhiều tài khoản, mỗi tài khoản = 1 user Linux <worker_prefix><khoá>.
// Khoá tài khoản default = agent id, nên mọi dữ liệu cũ (energy, login, usage_limited_until:<agent>) vẫn dùng được.

const SLUG_RE = /^[a-z0-9]{1,12}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export function accountKey(agent: string, slug: string): string {
  return slug === 'default' ? agent : `${agent}-${slug}`;
}

export function validateSlug(cfg: Config, agent: string, slug: string): string | null {
  if (!cfg.agents[agent]) return `unknown worker: ${agent}`;
  // Boss (decision 0003) chạy bằng API key trong kho, không có tài khoản đăng nhập → không thêm / nhập tài khoản phụ.
  if (cfg.agents[agent]!.provider === 'zai') return 'Boss uses an API key, it has no login accounts';
  if (slug === 'default' || !SLUG_RE.test(slug)) return 'slug must be 1-12 of a-z0-9 and not "default"';
  const key = accountKey(agent, slug);
  if (cfg.agents[key]) return `account key ${key} equals another agent id`;
  if (cfg.host.worker_prefix && !USER_RE.test(`${cfg.host.worker_prefix}${key}`)) return 'account name too long';
  return null;
}

/** Tài khoản theo thứ tự; agent chưa có dòng nào (store cũ/test) → tài khoản default đang bật. */
function accountsOf(store: Store, agent: string): Array<{ slug: string; active: boolean; tool: Tool | null }> {
  const rows = store.listAccounts(agent);
  return rows.length ? rows : [{ slug: 'default', active: true, tool: null }];
}

// Anh Zon 2026-11-14: một member (Worker) dùng nhiều công cụ – công cụ gắn theo tài khoản; null = công cụ của Worker.
export function toolOfAccount(cfg: Config, store: Pick<Store, 'getAccount'>, agent: string, slug: string): Tool {
  return store.getAccount(agent, slug)?.tool ?? cfg.agents[agent]!.tool;
}

/** Công cụ của tài khoản theo khoá (khoá default = agent id). Khoá lạ → null. */
export function toolOfAccountKey(cfg: Config, store: Store, key: string): Tool | null {
  if (cfg.agents[key]) return store.getAccount(key, 'default')?.tool ?? cfg.agents[key]!.tool;
  for (const a of store.listAccounts()) if (cfg.agents[a.agent] && accountKey(a.agent, a.slug) === key) return a.tool ?? cfg.agents[a.agent]!.tool;
  return null;
}

/**
 * Ghế chỉ đọc (QC, Audit) không dùng được Antigravity (agy không có chế độ chỉ đọc). Chỉ chặn tài khoản Antigravity THÊM cho
 * Worker không phải agy: Worker agy gốc đã bị config.ts cấm ngồi QC/Audit (cấu hình sai bị từ chối lúc nạp).
 */
export const canRunOnSeat = (tool: Tool, seat: Seat, workerTool: Tool) => !(tool === 'antigravity-cli' && workerTool !== 'antigravity-cli' && READ_ONLY_SEATS.has(seat));

export function agentOfAccount(cfg: Config, store: Store, key: string): string | null {
  if (cfg.agents[key]) return key;
  for (const a of store.listAccounts()) if (cfg.agents[a.agent] && accountKey(a.agent, a.slug) === key) return a.agent;
  return null;
}

/** Khoá của mọi tài khoản đang bật trên máy này (chỉ những tài khoản này được chạy/đọc energy/kiểm tra đăng nhập). */
export function activeAccountKeys(cfg: Config, store: Store): string[] {
  const keys: string[] = [];
  for (const agent of Object.keys(cfg.agents)) {
    for (const a of accountsOf(store, agent)) if (a.active) keys.push(accountKey(agent, a.slug));
  }
  return keys.sort();
}

export function isUsable(store: Store, key: string, now: Date): boolean {
  const until = store.getSetting(usageLimitedKey(key));
  if (until && Date.parse(until) > now.getTime()) return false;
  return store.latestLogin(key)?.state !== 'relogin';
}

/** Tài khoản dùng được theo thứ tự: đang bật, không bị giới hạn (hoặc đã qua giờ reset), đăng nhập không phải relogin. */
/** readOnly: lượt chỉ đọc (QC / Audit / hỏi đáp / họp) → bỏ tài khoản Antigravity. */
export function usableAccounts(cfg: Config, store: Store, agent: string, now = new Date(), opts: { readOnly?: boolean } = {}): Array<{ key: string; slug: string }> {
  const workerTool = cfg.agents[agent]?.tool;
  const active = accountsOf(store, agent).filter((a) => a.active && !(opts.readOnly && workerTool && !canRunOnSeat(a.tool ?? workerTool, 'qc', workerTool)));
  const candidates = cfg.rules.auto_switch_accounts === false ? active.slice(0, 1) : active;
  return candidates.map((a) => ({ key: accountKey(agent, a.slug), slug: a.slug })).filter((a) => isUsable(store, a.key, now));
}

export function pickAccount(cfg: Config, store: Store, agent: string, now = new Date(), opts: { readOnly?: boolean } = {}): { key: string; slug: string } | null {
  return usableAccounts(cfg, store, agent, now, opts)[0] ?? null;
}

/** Giờ reset sớm nhất trong các tài khoản đang bật bị giới hạn (để báo lý do); null nếu không có. */
export function soonestReset(store: Store, agent: string, now = new Date()): string | null {
  const times = accountsOf(store, agent)
    .filter((a) => a.active)
    .map((a) => store.getSetting(usageLimitedKey(accountKey(agent, a.slug))))
    .filter((t): t is string => !!t && Date.parse(t) > now.getTime())
    .sort((x, y) => Date.parse(x) - Date.parse(y));
  return times[0] ?? null;
}

export const accountLastKey = (agent: string) => `account_last:${agent}`;
export function slugOfKey(agent: string, key: string): string {
  return key === agent ? 'default' : key.slice(agent.length + 1);
}
