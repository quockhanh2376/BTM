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
  let catOut = SECRET;
  let execCalls: Array<{ file: string; args: string[]; input?: string }>;
  let spawned: string[][];
  let children: EventEmitter[];

  beforeEach(async () => {
    store = openStore(':memory:');
    const c = loadConfig('btm.config.yaml');
    cfg = { ...c, host: { ...c.host, worker_prefix: 'btm-', work_root: '/srv/btm-work', trusted_root: '/srv/btm-repos' } } as Config;
    store.ensureDefaultAccounts(Object.keys(cfg.agents));
    execCalls = [];
    spawned = [];
    children = [];
    busy = false;
    catOut = SECRET;
    const exec = (file: string, args: string[], o?: { input?: string }) => {
      execCalls.push({ file, args, input: o?.input });
      return Buffer.from(args.includes('cat') ? catOut : '');
    };
    const spawn = (file: string, args: string[]) => {
      spawned.push([file, ...args]);
      const ev = new EventEmitter();
      children.push(ev);
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
    // review M1: chưa đăng nhập xong → tài khoản tắt (không bị chọn chạy lượt); đăng nhập khác đang chạy → 409, không tạo dòng
    expect(store.getAccount('jenny', 'b')?.active).toBe(false);
    expect((await post('/api/accounts', { agent: 'jenny', slug: 'c' })).status).toBe(409);
    expect(store.getAccount('jenny', 'c')).toBeNull();
    children[0]!.emit('exit', 0);
    expect(store.getAccount('jenny', 'b')?.active).toBe(true);
    // đăng nhập lại tài khoản có sẵn; agy không hỗ trợ; tài khoản lạ 404
    store.updateAccount('jenny', 'b', { active: false });
    const again = await (await post('/api/accounts/jenny-b/login', {})).json();
    expect(again.loginId).toMatch(/^[0-9a-f]{16}$/);
    children[1]!.emit('exit', 1);
    expect(store.getAccount('jenny', 'b')?.active).toBe(false);
    expect((await post('/api/accounts/jacky/login', {})).status).toBe(400);
    expect((await post('/api/accounts/jenny-zz/login', {})).status).toBe(404);
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
    expect(Array.isArray(file)).toBe(true);
    // file token không đọc ra refresh_token → giữ mục đầy đủ
    const b = file.find((a: any) => a.slug === 'b');
    expect(b).toEqual({ agent: 'jacky', slug: 'b', tool: 'antigravity-cli', email: null, label: 'ide', files: { '.gemini/antigravity-cli/antigravity-oauth-token': SECRET } });
    expect(file.find((a: any) => a.agent === 'jenny')).toMatchObject({ tool: 'codex-cli', files: { '.codex/auth.json': SECRET } });
  });

  it('định dạng Antigravity [{email, refresh_token}]: import vào Worker agy, slug theo email, trùng email → ghi đè đúng tài khoản; export agy ra cùng dạng', async () => {
    store.updateAccount('jacky', 'default', { email: 'old@x.io' });
    store.addAccount('jacky', 'zon', { email: 'other@x.io', active: false });
    const file = [
      { email: 'first.Person2016@example.com', refresh_token: AGY_RT },
      { email: 'old@x.io', refresh_token: AGY_RT },
      { email: 'zon@y.io', refresh_token: AGY_RT },
      { email: 'bad', refresh_token: AGY_RT },
      { email: 'c@x.io', refresh_token: AGY_RT, agent: 'jenny' },
    ];
    const dry = await (await post('/api/accounts/import', { file, dryRun: true })).json();
    // Một member dùng nhiều công cụ (2026-11-14): ghi rõ agent thì tài khoản agy vào Worker nào cũng được.
    expect(dry.new).toEqual(['jacky/firstperson2', 'jenny/c']);
    expect(dry.conflicts).toEqual(['jacky/default']);
    expect(dry.rejected.map((x: any) => x.reason)).toEqual(['name taken by another account', 'email missing or invalid']);
    expect(JSON.stringify(dry)).not.toContain(AGY_RT);
    const real = await (await post('/api/accounts/import', { file })).json();
    expect(real.imported).toEqual(['jacky/firstperson2', 'jenny/c']);
    expect(store.getAccount('jacky', 'firstperson2')).toMatchObject({ email: 'first.Person2016@example.com', active: false, tool: null });
    expect(store.getAccount('jenny', 'c')).toMatchObject({ tool: 'antigravity-cli' });
    const w = execCalls.find((c) => c.args.includes('btm-jacky-firstperson2') && c.input);
    expect(JSON.parse(JSON.parse(w!.input!)['.gemini/antigravity-cli/antigravity-oauth-token']).token.refresh_token).toBe(AGY_RT);
    // export: file token agy đọc được → {email, refresh_token}
    catOut = JSON.stringify({ token: { refresh_token: AGY_RT }, id_token_email: 'x@x.io' });
    const out = await (await post('/api/accounts/export', {})).json();
    expect(out.filter((a: any) => !a.files)).toEqual([
      { email: 'old@x.io', refresh_token: AGY_RT },
      { email: 'other@x.io', refresh_token: AGY_RT },
      { email: 'first.Person2016@example.com', refresh_token: AGY_RT },
      // tài khoản agy của Worker không phải agy: xuất kèm `agent` để nhập lại đúng chỗ
      { email: 'c@x.io', refresh_token: AGY_RT, agent: 'jenny' },
    ]);
  });

  it('import Antigravity chọn Worker đích (agent): mục không ghi agent vào Worker đó (acc cho Finn), ghi agent thì giữ; Worker lạ/Boss bị từ chối', async () => {
    const file = [{ email: 't1@x.io', refresh_token: AGY_RT }, { email: 't2@x.io', refresh_token: AGY_RT, agent: 'jenny' }];
    const dry = await (await post('/api/accounts/import', { file, dryRun: true, agent: 'elon' })).json();
    expect(dry.new).toEqual(['elon/t1', 'jenny/t2']);
    await post('/api/accounts/import', { file, agent: 'elon' });
    expect(store.getAccount('elon', 't1')).toMatchObject({ tool: 'antigravity-cli' });
    expect((await post('/api/accounts/import', { file, dryRun: true, agent: 'nobody' })).status).toBe(400);
    expect((await post('/api/accounts/import', { file, dryRun: true, agent: 'mb' })).status).toBe(400);
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
        { agent: 'jenny', slug: 'c', tool: 'codex-cli', files: { '.codex/auth.json': 'other' } },
      ],
    };
    const dry = await (await post('/api/accounts/import', { file, dryRun: true })).json();
    expect(dry.new).toEqual(['jenny/c', 'jacky/e']);
    expect(dry.conflicts).toEqual(['jacky/b']);
    expect(dry.rejected.map((x: any) => x.reason)).toEqual(['files not allowed for this tool', 'unknown worker on this machine', 'bad entry', 'duplicate in file']);
    expect(execCalls).toHaveLength(0);
    const real = await (await post('/api/accounts/import', { file })).json();
    expect(real.imported).toEqual(['jenny/c', 'jacky/e']);
    expect(store.getAccount('jenny', 'c')).toMatchObject({ active: false, label: 'cli', tool: null });
    expect(store.getAccount('jacky', 'e')).toMatchObject({ active: false, tool: 'codex-cli' }); // Worker agy có thêm tài khoản Codex
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
