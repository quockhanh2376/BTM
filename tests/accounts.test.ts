import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.ts';
import { accountKey, validateSlug, pickAccount, agentOfAccount, activeAccountKeys } from '../src/agents/accounts.ts';
import { usageLimitedKey } from '../src/agents/usage-limit.ts';

const cfg = (extra: Record<string, unknown> = {}) =>
  ({
    host: { worker_prefix: 'btm-' },
    rules: { auto_switch_accounts: true },
    agents: { jacky: { tool: 'antigravity-cli' }, elon: { tool: 'claude-code' }, 'jacky-z': { tool: 'codex-cli' } },
    ...extra,
  }) as any;

function seed() {
  const store = openStore(':memory:');
  store.ensureDefaultAccounts(['jacky', 'elon']);
  store.addAccount('jacky', 'b', { active: true });
  store.addAccount('jacky', 'c', { active: false });
  return store;
}
const now = new Date('2026-11-12T10:00:00Z');
const later = new Date(now.getTime() + 3600e3).toISOString();
const earlier = new Date(now.getTime() - 60e3).toISOString();

describe('P7-T1: khoá tài khoản + slug', () => {
  it('accountKey: default = agent id', () => {
    expect(accountKey('jacky', 'default')).toBe('jacky');
    expect(accountKey('jacky', 'b')).toBe('jacky-b');
  });
  it('validateSlug từ chối default, chữ hoa, _, quá 12 ký tự, trùng id agent khác', () => {
    for (const s of ['default', 'B', 'a_b', 'x'.repeat(13), '']) expect(validateSlug(cfg(), 'jacky', s)).not.toBeNull();
    expect(validateSlug(cfg(), 'jacky', 'z')).toMatch(/agent/);
    expect(validateSlug(cfg(), 'jacky', 'b2')).toBeNull();
    expect(validateSlug(cfg(), 'nobody', 'b')).toMatch(/unknown/);
  });
  it('agentOfAccount + activeAccountKeys', () => {
    const store = seed();
    expect(agentOfAccount(cfg(), store, 'jacky-b')).toBe('jacky');
    expect(agentOfAccount(cfg(), store, 'jacky')).toBe('jacky');
    expect(agentOfAccount(cfg(), store, 'jacky-q')).toBeNull();
    expect(activeAccountKeys(cfg(), store)).toEqual(['elon', 'jacky', 'jacky-b', 'jacky-z']);
  });
});

describe('P7-T1: chọn tài khoản đầu tiên còn dùng được', () => {
  it('a hết → b; b hết → null (c ngủ); a qua giờ reset → quay lại a', () => {
    const store = seed();
    expect(pickAccount(cfg(), store, 'jacky', now)?.key).toBe('jacky');
    store.setSetting(usageLimitedKey('jacky'), later);
    expect(pickAccount(cfg(), store, 'jacky', now)).toEqual({ key: 'jacky-b', slug: 'b' });
    store.setSetting(usageLimitedKey('jacky-b'), later);
    expect(pickAccount(cfg(), store, 'jacky', now)).toBeNull();
    store.setSetting(usageLimitedKey('jacky'), earlier);
    expect(pickAccount(cfg(), store, 'jacky', now)?.key).toBe('jacky');
  });
  it('đăng nhập gần nhất relogin → bỏ qua; chưa kiểm tra → vẫn dùng', () => {
    const store = seed();
    store.setSetting(usageLimitedKey('jacky'), later);
    store.saveLogin({ agent: 'jacky-b', state: 'relogin', detail: 'x' });
    store.updateAccount('jacky', 'c', { active: true });
    expect(pickAccount(cfg(), store, 'jacky', now)?.key).toBe('jacky-c');
  });
  it('auto_switch_accounts false → chỉ tài khoản đầu tiên đang bật', () => {
    const store = seed();
    const c = cfg({ rules: { auto_switch_accounts: false } });
    expect(pickAccount(c, store, 'jacky', now)?.key).toBe('jacky');
    store.setSetting(usageLimitedKey('jacky'), later);
    expect(pickAccount(c, store, 'jacky', now)).toBeNull();
    store.updateAccount('jacky', 'default', { active: false });
    store.setSetting(usageLimitedKey('jacky'), earlier);
    expect(pickAccount(c, store, 'jacky', now)?.key).toBe('jacky-b');
  });
  it('agent chưa có dòng nào (store cũ) → coi như tài khoản default đang bật', () => {
    const store = openStore(':memory:');
    expect(pickAccount(cfg(), store, 'jacky', now)).toEqual({ key: 'jacky', slug: 'default' });
  });
});

describe('P7-T1: store tài khoản', () => {
  it('ensureDefaultAccounts không nhân đôi; addAccount trùng throw; moveAccount', () => {
    const store = seed();
    store.ensureDefaultAccounts(['jacky']);
    expect(store.listAccounts('jacky').map((a) => [a.slug, a.ord, a.active])).toEqual([['default', 0, true], ['b', 1, true], ['c', 2, false]]);
    expect(() => store.addAccount('jacky', 'b', { active: true })).toThrow();
    store.moveAccount('jacky', 'c', 'up');
    expect(store.listAccounts('jacky').map((a) => a.slug)).toEqual(['default', 'c', 'b']);
    store.moveAccount('jacky', 'default', 'up');
    store.moveAccount('jacky', 'b', 'down');
    expect(store.listAccounts('jacky').map((a) => a.slug)).toEqual(['default', 'c', 'b']);
    store.updateAccount('jacky', 'b', { label: 'ide', email: 'x@y.z' });
    expect(store.getAccount('jacky', 'b')).toMatchObject({ label: 'ide', email: 'x@y.z' });
  });
});
