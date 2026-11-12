import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { openStore, type Store } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createServer } from '../src/server/http.ts';
import { buildSnapshot } from '../src/server/snapshot.ts';
import { resetLoginFlows } from '../src/agents/login-flow.ts';

const SECRET = 'tok-SECRET-123';
const AGY_RT = '1//0SECRETrefresh';

describe('P7-T4: API tài khoản', () => {
  let store: Store;
  let cfg: Config;
  let server: Server;
  let base = '';
  let busy = false;
  let execCalls: Array<{ file: string; args: string[]; input?: string }>;
  let spawned: string[][];

  beforeEach(async () => {
    store = openStore(':memory:');
    const c = loadConfig('btm.config.yaml');
    cfg = { ...c, host: { ...c.host, worker_prefix: 'btm-', work_root: '/srv/btm-work', trusted_root: '/srv/btm-repos' } } as Config;
    store.ensureDefaultAccounts(Object.keys(cfg.agents));
    execCalls = [];
    spawned = [];
    busy = false;
    const exec = (file: string, args: string[], o?: { input?: string }) => {
      execCalls.push({ file, args, input: o?.input });
      return Buffer.from(args.includes('cat') ? SECRET : '');
    };
    const spawn = (file: string, args: string[]) => {
      spawned.push([file, ...args]);
      const ev = new EventEmitter();
      return { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), on: (e: string, f: any) => ev.on(e, f), kill: () => {} } as any;
    };
    server = createServer({ cfg, store, host: { busy: () => busy } as any, webFile: resolve(__dirname, '../web/index.html'), pollMs: 50, accountExec: exec as any, loginSpawn: spawn });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterEach(async () => {
    resetLoginFlows();
    await new Promise((r) => server.close(r));
    store.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-btm': '1' }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });

  it('thêm tài khoản: kiểm tra dữ liệu, bận → 409, trùng → 409', async () => {
    expect((await post('/api/accounts', { agent: 'nobody', slug: 'b' })).status).toBe(400);
    expect((await post('/api/accounts', { agent: 'jacky', slug: 'B!' })).status).toBe(400);
    expect((await post('/api/accounts', { agent: 'jacky', slug: 'default' })).status).toBe(400);
    expect((await post('/api/accounts', { agent: 'jacky', slug: 'b' })).status).toBe(400); // agy cần JSON
    busy = true;
    expect((await post('/api/accounts', { agent: 'jenny', slug: 'b' })).status).toBe(409);
    busy = false;
    expect((await post('/api/accounts', { agent: 'jenny', slug: 'b' })).status).toBe(200);
    expect((await post('/api/accounts', { agent: 'jenny', slug: 'b' })).status).toBe(409);
  });

  it('agy: tạo user + ghi file token dưới user mới, response không có token, email lưu lại, mặc định bật', async () => {
    const r = await post('/api/accounts', { agent: 'jacky', slug: 'b', agy: { email: 'b@x.io', refresh_token: AGY_RT } });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ key: 'jacky-b', loginId: null });
    expect(text).not.toContain(AGY_RT);
    expect(execCalls[0]).toMatchObject({ file: 'sudo', args: ['-n', '/usr/local/bin/btm-account', 'add', 'btm-jacky-b'] });
    expect(execCalls[1]!.args.slice(0, 3)).toEqual(['-n', '-u', 'btm-jacky-b']);
    expect(execCalls[1]!.input).toContain(AGY_RT);
    expect(store.getAccount('jacky', 'b')).toMatchObject({ email: 'b@x.io', active: true, ord: 1 });
    expect(spawned).toHaveLength(0);
  });

  it('codex: bắt đầu đăng nhập dưới user mới, đọc trạng thái qua GET', async () => {
    const r = await post('/api/accounts', { agent: 'jenny', slug: 'b' });
    const { key, loginId } = await r.json();
    expect(key).toBe('jenny-b');
    expect(loginId).toMatch(/^[0-9a-f]{16}$/);
    expect(spawned[0]!.slice(0, 4)).toEqual(['sudo', '-n', '-u', 'btm-jenny-b']);
    const st = await (await fetch(`${base}/api/accounts/login/${loginId}`, { headers: { 'x-btm': '1' } })).json();
    expect(st).toMatchObject({ state: 'waiting', key: 'jenny-b' });
    expect((await fetch(`${base}/api/accounts/login/0000000000000000`, { headers: { 'x-btm': '1' } })).status).toBe(404);
  });

  it('sửa: nhãn, bật/tắt, thứ tự; tài khoản lạ → 404', async () => {
    store.addAccount('jacky', 'b', { active: true });
    expect((await post('/api/accounts/jacky-b', { active: false, label: 'ide' })).status).toBe(200);
    expect(store.getAccount('jacky', 'b')).toMatchObject({ active: false, label: 'ide' });
    expect((await post('/api/accounts/jacky-b', { move: 'up' })).status).toBe(200);
    expect(store.listAccounts('jacky').map((a) => a.slug)).toEqual(['b', 'default']);
    expect((await post('/api/accounts/jacky-zz', { active: true })).status).toBe(404);
    expect((await post('/api/accounts/jacky-b', { label: 'evil' })).status).toBe(400);
  });

  it('export: đúng header, có token, không có active/ord; thiếu x-btm → bị chặn', async () => {
    store.addAccount('jacky', 'b', { active: false, label: 'ide' });
    expect((await post('/api/accounts/export', {}, {})).status).not.toBe(200);
    const r = await post('/api/accounts/export', {});
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="btm-accounts-\d{8}\.json"$/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const file = await r.json();
    expect(file.version).toBe(1);
    const b = file.accounts.find((a: any) => a.slug === 'b');
    expect(b).toEqual({ agent: 'jacky', slug: 'b', tool: 'antigravity-cli', email: null, label: 'ide', files: { '.gemini/antigravity-cli/antigravity-oauth-token': SECRET } });
  });

  it('import: dryRun phân loại; chạy thật không ghi đè khi chưa tick; mục mới mặc định ngủ', async () => {
    store.addAccount('jacky', 'b', { active: true });
    const file = {
      version: 1,
      accounts: [
        { agent: 'jacky', slug: 'b', tool: 'antigravity-cli', email: 'b@x.io', files: { '.gemini/antigravity-cli/antigravity-oauth-token': SECRET } },
        { agent: 'jenny', slug: 'c', tool: 'codex-cli', email: null, label: 'cli', files: { '.codex/auth.json': SECRET } },
        { agent: 'jenny', slug: 'd', tool: 'codex-cli', files: { '../../.ssh/authorized_keys': 'ssh-rsa x' } },
        { agent: 'jacky', slug: 'e', tool: 'codex-cli', files: { '.codex/auth.json': SECRET } },
        { agent: 'ghost', slug: 'f', tool: 'codex-cli', files: { '.codex/auth.json': SECRET } },
        'garbage',
      ],
    };
    const dry = await (await post('/api/accounts/import', { file, dryRun: true })).json();
    expect(dry.new).toEqual(['jenny/c']);
    expect(dry.conflicts).toEqual(['jacky/b']);
    expect(dry.rejected.map((x: any) => x.reason)).toEqual(['files not allowed for this tool', 'tool mismatch (antigravity-cli)', 'unknown worker on this machine', 'bad entry']);
    expect(execCalls).toHaveLength(0);
    const real = await (await post('/api/accounts/import', { file })).json();
    expect(real.imported).toEqual(['jenny/c']);
    expect(store.getAccount('jenny', 'c')).toMatchObject({ active: false, label: 'cli' });
    expect(execCalls.some((c) => c.args.includes('btm-jacky-b'))).toBe(false);
    expect((await post('/api/accounts/import', { file: { version: 2, accounts: [] } })).status).toBe(400);
    busy = true;
    expect((await post('/api/accounts/import', { file })).status).toBe(409);
  });

  it('token không lọt vào snapshot hay console (Review Focus 2)', async () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    await post('/api/accounts', { agent: 'jacky', slug: 'b', agy: { email: 'b@x.io', refresh_token: AGY_RT } });
    await post('/api/accounts/export', {});
    await post('/api/accounts/import', { file: { version: 1, accounts: [{ agent: 'jenny', slug: 'c', tool: 'codex-cli', files: { '.codex/auth.json': SECRET } }] } });
    const snap = JSON.stringify(buildSnapshot(store, cfg));
    expect(snap).not.toContain(SECRET);
    expect(snap).not.toContain(AGY_RT);
    for (const s of [log, err]) for (const call of s.mock.calls) expect(String(call)).not.toMatch(/SECRET/);
    expect(JSON.parse(snap).accounts.find((a: any) => a.agent === 'jacky').accounts.map((a: any) => [a.slug, a.status])).toEqual([['default', 'in_use'], ['b', 'next']]);
  });
});
