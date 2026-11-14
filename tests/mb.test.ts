import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http, { type Server } from 'node:http';
import { openStore } from '../src/store/db.ts';
import { ConfigSchema, loadConfig, type Config } from '../src/config.ts';
import { cleanKey, decryptKey, encryptKey, loadMasterKey, mbStatus, readMbKey, removeMbKey, saveMbKey, setMbEnabled } from '../src/mb/vault.ts';
import { createMbProxy, issueTurnToken, revokeTurnToken } from '../src/mb/proxy.ts';
import { fetchZaiQuota, parseZaiQuota } from '../src/mb/quota.ts';
import { createMonitor } from '../src/energy/monitor.ts';
import { zaiArgv } from '../src/runner/run.ts';
import { listModels, ZAI_MODELS } from '../src/agents/models.ts';
import { createServer, type HostApi } from '../src/server/http.ts';
import { buildSnapshot } from '../src/server/snapshot.ts';
import { readAnswers, saveAnswer } from '../src/server/ask-lane.ts';

const KEY = 'zai-test-key-0123456789abcdefWXYZ';
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as any).port)));
const servers: Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

function setup() {
  const store = openStore(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'btm-mb-'));
  return { store, dataDir };
}

describe('Boss (MB) – kho key mã hoá (decision 0003)', () => {
  it('mã hoá ↔ giải mã; khoá khác → null; DB không chứa key thật; master.key 32 byte', () => {
    const t = setup();
    const m = loadMasterKey(t.dataDir);
    expect(m.length).toBe(32);
    expect(loadMasterKey(t.dataDir).equals(m)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(t.dataDir, 'keys', 'master.key')).mode & 0o777).toBe(0o600);
    const rec = encryptKey(KEY, m);
    expect(decryptKey(rec, m)).toBe(KEY);
    expect(decryptKey(rec, Buffer.alloc(32, 7))).toBeNull();
    saveMbKey(t.store, t.dataDir, KEY);
    expect(t.store.getSetting('mb_key')).not.toContain(KEY);
    expect(readMbKey(t.store, t.dataDir)).toBe(KEY);
    expect(mbStatus(t.store)).toEqual({ set: true, last4: 'WXYZ', enabled: true });
    setMbEnabled(t.store, false);
    expect(mbStatus(t.store).enabled).toBe(false);
    removeMbKey(t.store);
    expect(mbStatus(t.store).set).toBe(false);
    expect(readMbKey(t.store, t.dataDir)).toBeNull();
  });

  it('cleanKey: cắt khoảng trắng; rỗng/ngắn/có khoảng trắng giữa → null', () => {
    expect(cleanKey(`  ${KEY}\n`)).toBe(KEY);
    expect(cleanKey('')).toBeNull();
    expect(cleanKey('short')).toBeNull();
    expect(cleanKey('abc def ghi jkl mno pqr stu')).toBeNull();
  });
});

describe('Boss – cổng trung gian', () => {
  async function rig() {
    const t = setup();
    saveMbKey(t.store, t.dataDir, KEY);
    const seen: { auth?: string; path?: string } = {};
    const upstream = http.createServer((req, res) => {
      seen.auth = String(req.headers.authorization);
      seen.path = req.url;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      res.end('data: two\n\n');
    });
    servers.push(upstream);
    const up = await listen(upstream);
    const proxy = createMbProxy({ store: t.store, dataDir: t.dataDir, upstream: `http://127.0.0.1:${up}/api/anthropic` });
    servers.push(proxy);
    const port = await listen(proxy);
    const call = (token?: string) =>
      fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: '{}' });
    return { ...t, seen, call };
  }

  it('mã tạm hợp lệ → upstream nhận key thật, stream về nguyên; client không thấy key', async () => {
    const r = await rig();
    const tok = issueTurnToken(60_000);
    const res = await r.call(tok);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toBe('data: one\n\ndata: two\n\n');
    expect(r.seen.auth).toBe(`Bearer ${KEY}`);
    expect(r.seen.path).toBe('/api/anthropic/v1/messages');
    expect(JSON.stringify([...res.headers])).not.toContain(KEY);
    revokeTurnToken(tok);
  });

  it('không mã / mã thu hồi / mã hết hạn / Boss tắt / chưa có key → 401, không gọi upstream', async () => {
    const r = await rig();
    expect((await r.call()).status).toBe(401);
    const tok = issueTurnToken(60_000);
    revokeTurnToken(tok);
    expect((await r.call(tok)).status).toBe(401);
    expect((await r.call(issueTurnToken(-1))).status).toBe(401);
    const live = issueTurnToken(60_000);
    setMbEnabled(r.store, false);
    expect((await r.call(live)).status).toBe(401);
    setMbEnabled(r.store, true);
    removeMbKey(r.store);
    expect((await r.call(live)).status).toBe(401);
    expect(r.seen.auth).toBeUndefined();
  });
});

describe('Boss – agent, model, API', () => {
  it('argv lượt Boss: env trỏ cổng nội bộ + mã tạm, không có key thật', () => {
    const a = zaiArgv(['claude', '-p', 'x'], 'btm-turn-abc');
    expect(a.slice(0, 3)).toEqual(['env', 'ANTHROPIC_BASE_URL=http://127.0.0.1:8099', 'ANTHROPIC_AUTH_TOKEN=btm-turn-abc']);
    expect(a.slice(-3)).toEqual(['claude', '-p', 'x']);
  });

  it('câu trả lời của Boss bỏ dòng chẩn đoán model lạ của Claude Code; argv khai báo context GLM', () => {
    const store = openStore(':memory:');
    saveAnswer(store, '/p', { id: 1, seat: 'qc', asked: 'qc', agent: 'mb', question: 'q' } as any, {
      output: `Claude Code doesn't recognize the model "glm-5.3", so it assumes …\n[claude-code:unrecognized_model] {"model":"glm-5.3"}\nOK\nDạ, xong.`,
    });
    expect(readAnswers(store, '/p')[0]!.answer).toBe('OK\nDạ, xong.');
    expect(zaiArgv(['claude'], 't')).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000');
  });

  it('config: provider zai chỉ với claude-code; model GLM', async () => {
    const base = loadConfig('btm.config.yaml');
    const withMb = (tool: string) => ({ ...base, agents: { ...base.agents, mb: { tool, command: 'claude', can_sit: ['dev', 'qc'], provider: 'zai' } } });
    expect(ConfigSchema.safeParse(withMb('claude-code')).success).toBe(true);
    expect(ConfigSchema.safeParse(withMb('codex-cli')).success).toBe(false);
    expect(await listModels('claude-code', async () => ({ output: '' }) as any, 'zai')).toEqual(ZAI_MODELS);
  });

  it('POST /api/mb: lưu, không bao giờ trả key; key sai → 400; thiếu x-btm → 403; snapshot chỉ có …4 ký tự cuối', async () => {
    const t = setup();
    const store = t.store;
    store.setActiveProject(mkdtempSync(join(tmpdir(), 'btm-mb-p-')));
    const base = loadConfig('btm.config.yaml');
    const cfg = { ...base, host: { ...base.host, data_dir: t.dataDir } } as Config;
    const server = createServer({ cfg, store, host: {} as HostApi, webFile: resolve('web/index.html'), pollMs: 50 });
    servers.push(server);
    const port = await listen(server);
    const post = (body: unknown, h: Record<string, string> = { 'x-btm': '1' }) =>
      fetch(`http://127.0.0.1:${port}/api/mb`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
    expect((await post({ action: 'set', key: KEY }, {})).status).toBe(403);
    expect((await post({ action: 'set', key: 'x' })).status).toBe(400);
    const ok = await post({ action: 'set', key: KEY });
    const text = await ok.text();
    expect(ok.status).toBe(200);
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ set: true, last4: 'WXYZ', enabled: true });
    expect((await post({ action: 'disable' })).status).toBe(200);
    expect(mbStatus(store).enabled).toBe(false);
    expect(JSON.stringify(buildSnapshot(store, cfg))).not.toContain(KEY);
    expect(readMbKey(store, t.dataDir)).toBe(KEY);
  });
});

describe('Boss – Energy từ quota Z.ai', () => {
  it('parse: TOKENS_LIMIT thứ nhất = 5h, thứ hai = tuần; còn lại = 100 - đã dùng; thiếu dữ liệu → []', () => {
    const w = parseZaiQuota({ data: { limits: [
      { type: 'TOKENS_LIMIT', percentage: 12.4, nextResetTime: 1794600000000 },
      { type: 'TOKENS_LIMIT', percentage: 40, nextResetTime: 1795000000000 },
      { type: 'TIME_LIMIT', percentage: 0 },
    ] } });
    expect(w).toEqual([
      { name: '5h', remainingPercent: 88, resetsAt: new Date(1794600000000).toISOString() },
      { name: 'week', remainingPercent: 60, resetsAt: new Date(1795000000000).toISOString() },
    ]);
    expect(parseZaiQuota({})).toEqual([]);
    expect(parseZaiQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 'x' }] } })).toEqual([]);
  });

  it('fetch: gửi key thô (không Bearer) trong core; lỗi mạng/HTTP → []', async () => {
    let auth = '';
    const ok = (async (_u: unknown, init: any) => { auth = init.headers.Authorization; return new Response(JSON.stringify({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 0 }] } })); }) as any;
    expect((await fetchZaiQuota(KEY, ok))[0]!.remainingPercent).toBe(100);
    expect(auth).toBe(KEY);
    expect(await fetchZaiQuota(KEY, (async () => new Response('x', { status: 401 })) as any)).toEqual([]);
    expect(await fetchZaiQuota(KEY, (async () => { throw new Error('net'); }) as any)).toEqual([]);
  });

  it('monitor: Boss có key → Energy fresh từ quota; gate chặn khi dưới mức tối thiểu', async () => {
    const t = setup();
    saveMbKey(t.store, t.dataDir, KEY);
    const base = loadConfig('btm.config.yaml');
    const cfg = { ...base, host: { ...base.host, data_dir: t.dataDir, worker_prefix: '' }, agents: { ...base.agents, mb: { tool: 'claude-code', command: 'claude', can_sit: ['dev'], provider: 'zai' } } } as Config;
    t.store.ensureDefaultAccounts(Object.keys(cfg.agents));
    const seen: string[] = [];
    const m = createMonitor({ cfg, store: t.store, readEnergy: async () => { throw new Error('no CLI for Boss'); }, checkLogin: async () => { throw new Error('no CLI'); }, now: () => new Date(), zaiQuota: async (k) => { seen.push(k); return [{ name: '5h', remainingPercent: 5, resetsAt: new Date().toISOString() }]; } } as any);
    await m.refresh(['mb'], true);
    expect(seen).toEqual([KEY]);
    expect(t.store.latestEnergy('mb')).toMatchObject({ status: 'fresh', windows: [{ name: '5h', remainingPercent: 5 }] });
    expect(m.gate('mb').ok).toBe(false);
  });
});
