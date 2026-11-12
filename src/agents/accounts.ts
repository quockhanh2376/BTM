import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
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
  if (slug === 'default' || !SLUG_RE.test(slug)) return 'slug must be 1-12 of a-z0-9 and not "default"';
  const key = accountKey(agent, slug);
  if (cfg.agents[key]) return `account key ${key} equals another agent id`;
  if (cfg.host.worker_prefix && !USER_RE.test(`${cfg.host.worker_prefix}${key}`)) return 'account name too long';
  return null;
}

/** Tài khoản theo thứ tự; agent chưa có dòng nào (store cũ/test) → tài khoản default đang bật. */
function accountsOf(store: Store, agent: string): Array<{ slug: string; active: boolean }> {
  const rows = store.listAccounts(agent);
  return rows.length ? rows : [{ slug: 'default', active: true }];
}

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

/** Tài khoản đầu tiên theo thứ tự: đang bật, không bị giới hạn (hoặc đã qua giờ reset), đăng nhập không phải relogin. */
export function pickAccount(cfg: Config, store: Store, agent: string, now = new Date()): { key: string; slug: string } | null {
  const active = accountsOf(store, agent).filter((a) => a.active);
  const candidates = cfg.rules.auto_switch_accounts === false ? active.slice(0, 1) : active;
  for (const a of candidates) {
    const key = accountKey(agent, a.slug);
    if (isUsable(store, key, now)) return { key, slug: a.slug };
  }
  return null;
}
