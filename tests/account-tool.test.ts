// Một member (Worker) dùng nhiều công cụ: công cụ gắn theo tài khoản (anh Zon 2026-11-14).
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
import { pickAccount, seatOpts, toolOfAccount, toolOfAccountKey, usableAccounts } from '../src/agents/accounts.ts';
import { makeRunner } from '../src/runner/run.ts';
import { readWeb } from './helpers.ts';

const AGY_RT = '1//0SECRETrefresh';
const cfgOf = (extra: Record<string, unknown> = {}) =>
  ({
    host: { worker_prefix: 'btm-' },
    rules: { auto_switch_accounts: true },
    agents: { finn: { tool: 'claude-code', can_sit: ['pm', 'qc'] }, john: { tool: 'antigravity-cli', can_sit: ['dev'] } },
    ...extra,
  }) as any;

/** Finn: Claude (default) + Antigravity (finn-agy); thứ tự do anh xếp. */
function seed() {
  const store = openStore(':memory:');
  store.ensureDefaultAccounts(['finn', 'john']);
  store.addAccount('finn', 'agy', { active: true, tool: 'antigravity-cli' });
  return store;
}

describe('Công cụ theo tài khoản: chọn tài khoản', () => {
  it('tài khoản không ghi công cụ theo Worker; có ghi thì theo ghi; theo khoá cũng tra được', () => {
    const store = seed();
    const cfg = cfgOf();
    expect(toolOfAccount(cfg, store, 'finn', 'default')).toBe('claude-code');
    expect(toolOfAccount(cfg, store, 'finn', 'agy')).toBe('antigravity-cli');
    expect(toolOfAccount(cfg, store, 'john', 'default')).toBe('antigravity-cli');
    expect(toolOfAccountKey(cfg, store, 'finn')).toBe('claude-code');
    expect(toolOfAccountKey(cfg, store, 'finn-agy')).toBe('antigravity-cli');
    expect(toolOfAccountKey(cfg, store, 'nobody')).toBeNull();
    expect(store.getAccount('finn', 'agy')).toMatchObject({ tool: 'antigravity-cli' });
    expect(store.getAccount('finn', 'default')).toMatchObject({ tool: null });
  });

  it('theo thứ tự anh xếp: Claude hết hạn mức thì Finn dùng Antigravity; bài Antigravity code thì QC/Audit bỏ tài khoản Antigravity', () => {
    const store = seed();
    const cfg = cfgOf({ seats: { pm: 'finn', dev: 'john', qc: 'finn', audit: '' } });
    const now = new Date('2026-11-14T10:00:00Z');
    expect(usableAccounts(cfg, store, 'finn', now).map((a) => a.key)).toEqual(['finn', 'finn-agy']);
    store.setSetting('usage_limited_until:finn', new Date(now.getTime() + 3600e3).toISOString());
    expect(pickAccount(cfg, store, 'finn', now)!.key).toBe('finn-agy'); // ghế PM/Dev: chạy tiếp bằng Antigravity
    // Dev (John) chạy Antigravity → QC/Audit không lấy tài khoản Antigravity; PM/Dev không bị ảnh hưởng
    expect(seatOpts(cfg, store, 'qc')).toEqual({ avoidTool: 'antigravity-cli' });
    expect(seatOpts(cfg, store, 'audit')).toEqual({ avoidTool: 'antigravity-cli' });
    expect(seatOpts(cfg, store, 'pm')).toEqual({});
    expect(pickAccount(cfg, store, 'finn', now, seatOpts(cfg, store, 'qc'))).toBeNull();
    // Dev chạy công cụ khác (lượt gần nhất của John bằng tài khoản Codex) → QC dùng Antigravity bình thường
    store.addAccount('john', 'cx', { active: true, tool: 'codex-cli' });
    store.setSetting('account_last:john', 'john-cx');
    expect(seatOpts(cfg, store, 'qc')).toEqual({});
    expect(pickAccount(cfg, store, 'finn', now, seatOpts(cfg, store, 'qc'))!.key).toBe('finn-agy');
  });
});

describe('Công cụ theo tài khoản: runner', () => {
  const runnerCfg = () => {
    const base = loadConfig('btm.config.yaml');
    return { ...base, agents: { ...base.agents, finn: { tool: 'claude-code', command: 'claude', can_sit: ['pm', 'qc'] } }, host: { ...base.host, worker_prefix: '' } } as Config;
  };
  const make = (toolOf: (k: string) => any) => {
    const argvs: string[][] = [];
    const runProc = vi.fn(async (argv: string[]) => { argvs.push(argv); return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' } as any; });
    const cfg = runnerCfg();
    const settings = { getSetting: (k: string) => (k === 'agent_model:finn' ? 'opus' : null) };
    return { argvs, runner: makeRunner(cfg, undefined, runProc as any, () => {}, undefined, settings, toolOf) };
  };

  it('tài khoản Antigravity của Finn chạy bằng agy (không dùng model/effort của Finn); tài khoản Claude chạy bằng claude với model của Finn', async () => {
    const { argvs, runner } = make((key) => (key === 'finn-agy' ? 'antigravity-cli' : 'claude-code'));
    await runner('pm', 'finn', 'làm việc', process.cwd(), 'logs/a.log', { account: 'finn-agy' });
    expect(argvs[0].join(' ')).toContain('agy -p');
    expect(argvs[0].join(' ')).not.toContain('opus');
    await runner('pm', 'finn', 'làm việc', process.cwd(), 'logs/b.log', { account: 'finn' });
    expect(argvs[1][0]).toBe('claude');
    expect(argvs[1]).toContain('opus');
  });

  it('Antigravity ở ghế chỉ đọc (QC/Audit) chạy --mode plan, không được chạy lệnh nào; ghế Dev vẫn accept-edits', async () => {
    const { argvs, runner } = make(() => 'antigravity-cli');
    await runner('qc', 'finn', 'kiểm', process.cwd(), 'logs/c.log', { account: 'finn-agy' });
    await runner('audit', 'finn', 'kiểm', process.cwd(), 'logs/d.log', { account: 'finn-agy' });
    await runner('pm', 'finn', 'làm', process.cwd(), 'logs/e.log', { account: 'finn-agy' });
    for (const i of [0, 1]) {
      expect(argvs[i].join(' ')).toContain('--mode plan');
      expect(argvs[i].join(' ')).toContain('"allow":[]');
      expect(argvs[i].join(' ')).not.toContain('accept-edits');
    }
    expect(argvs[2].join(' ')).toContain('--mode accept-edits');
  });
});

describe('Công cụ theo tài khoản: API + snapshot + giao diện', () => {
  let store: Store;
  let cfg: Config;
  let server: Server;
  let base = '';
  let execCalls: Array<{ args: string[]; input?: string }>;
  let spawned: string[][];

  beforeEach(async () => {
    store = openStore(':memory:');
    const c = loadConfig('btm.config.yaml');
    cfg = { ...c, agents: { ...c.agents, mb: { tool: 'claude-code', command: 'claude', provider: 'zai', can_sit: ['pm', 'dev', 'qc', 'audit'] } }, host: { ...c.host, worker_prefix: 'btm-', work_root: '/srv/btm-work', trusted_root: '/srv/btm-repos' } } as Config;
    store.ensureDefaultAccounts(Object.keys(cfg.agents));
    execCalls = [];
    spawned = [];
    const exec = (_f: string, args: string[], o?: { input?: string }) => { execCalls.push({ args, input: o?.input }); return Buffer.from(''); };
    const spawn = (file: string, args: string[]) => {
      spawned.push([file, ...args]);
      const ev = new EventEmitter();
      return { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), on: (e: string, f: any) => ev.on(e, f), kill: () => {} } as any;
    };
    server = createServer({ cfg, store, host: { busy: () => false } as any, webFile: resolve(__dirname, '../web/index.html'), pollMs: 50, accountExec: exec as any, loginSpawn: spawn });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => {
    resetLoginFlows();
    await new Promise((r) => server.close(r));
    store.close();
  });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: base, 'x-btm': '1' }, body: JSON.stringify(body) });

  it('thêm tài khoản Antigravity cho Worker Claude (cần JSON agy); thêm Codex cho Worker agy; công cụ mặc định theo Worker lưu null', async () => {
    const claudeWorker = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'claude-code' && !cfg.agents[a]!.provider)!;
    const agyWorker = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'antigravity-cli')!;
    expect((await post('/api/accounts', { agent: claudeWorker, slug: 'agy1', tool: 'antigravity-cli' })).status).toBe(400); // thiếu JSON agy
    const r = await post('/api/accounts', { agent: claudeWorker, slug: 'agy1', tool: 'antigravity-cli', agy: { email: 'f@x.io', refresh_token: AGY_RT } });
    expect(r.status).toBe(200);
    expect(store.getAccount(claudeWorker, 'agy1')).toMatchObject({ tool: 'antigravity-cli', active: true, email: 'f@x.io' });
    const w = execCalls.find((c) => c.args.includes(`btm-${claudeWorker}-agy1`) && c.input);
    expect(JSON.parse(JSON.parse(w!.input!)['.gemini/antigravity-cli/antigravity-oauth-token']).token.refresh_token).toBe(AGY_RT);
    // Worker agy thêm tài khoản Codex: đăng nhập qua luồng của codex
    const c = await post('/api/accounts', { agent: agyWorker, slug: 'cx', tool: 'codex-cli' });
    expect(c.status).toBe(200);
    expect(store.getAccount(agyWorker, 'cx')).toMatchObject({ tool: 'codex-cli', active: false });
    expect(spawned.some((s) => s.join(' ').includes('codex'))).toBe(true);
    resetLoginFlows(); // mỗi lúc chỉ một đăng nhập
    // Cùng công cụ với Worker → vẫn lưu null; công cụ lạ → 400; Boss không có tài khoản phụ
    expect((await post('/api/accounts', { agent: claudeWorker, slug: 'cl2', tool: 'claude-code' })).status).toBe(200);
    expect(store.getAccount(claudeWorker, 'cl2')).toMatchObject({ tool: null });
    expect((await post('/api/accounts', { agent: claudeWorker, slug: 'x', tool: 'gemini' })).status).toBe(400);
    expect((await post('/api/accounts', { agent: 'mb', slug: 'x', tool: 'claude-code' })).status).toBe(400);
    // Đăng nhập lại tài khoản agy của Worker Claude: theo công cụ của tài khoản → báo thêm lại từ JSON
    expect((await post(`/api/accounts/${claudeWorker}-agy1/login`, {})).status).toBe(400);
  });

  it('email trùng: import bỏ qua mục đã có ở thẻ khác hoặc lặp trong file, chỉ nhận email mới; thêm tay email đã có → 409', async () => {
    const agyWorker = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'antigravity-cli')!;
    const claudeWorker = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'claude-code' && !cfg.agents[a]!.provider)!;
    const first = [{ email: 'a@x.io', refresh_token: AGY_RT }, { email: 'b@x.io', refresh_token: AGY_RT }, { email: 'c@x.io', refresh_token: AGY_RT }];
    expect((await (await post('/api/accounts/import', { file: first })).json()).imported).toHaveLength(3);
    // Lần 2: 3 mục vào thẻ khác, 1 email đã có (viết hoa khác) + 1 email lặp trong file → chỉ thêm 2
    const second = [{ email: 'B@x.io', refresh_token: AGY_RT }, { email: 'd@x.io', refresh_token: AGY_RT }, { email: 'e@x.io', refresh_token: AGY_RT }, { email: 'd@x.io', refresh_token: AGY_RT }];
    const dry = await (await post('/api/accounts/import', { file: second, dryRun: true, agent: claudeWorker })).json();
    expect(dry.new).toEqual([`${claudeWorker}/d`, `${claudeWorker}/e`]);
    expect(dry.skipped).toEqual([{ entry: 'B@x.io', at: `${agyWorker}/b` }]);
    expect(dry.rejected).toEqual([{ entry: `${claudeWorker}/d`, reason: 'duplicate in file' }]);
    const real = await (await post('/api/accounts/import', { file: second, agent: claudeWorker })).json();
    expect(real.imported).toEqual([`${claudeWorker}/d`, `${claudeWorker}/e`]);
    expect(store.getAccount(claudeWorker, 'b')).toBeNull();
    // Cùng email, cùng thẻ: vẫn là "trùng" để tick ghi đè (nạp lại token), không bị bỏ qua
    const again = await (await post('/api/accounts/import', { file: [{ email: 'a@x.io', refresh_token: AGY_RT }], dryRun: true })).json();
    expect([again.conflicts, again.skipped]).toEqual([[`${agyWorker}/a`], []]);
    const r = await post('/api/accounts', { agent: claudeWorker, slug: 'dup', tool: 'antigravity-cli', agy: { email: 'c@x.io', refresh_token: AGY_RT } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe(`Email already used by ${agyWorker}/c`);
    expect(buildSnapshot(store, cfg).accounts.flatMap((w) => w.accounts).every((a) => a.dupOf === null)).toBe(true);
  });

  it('chuyển tài khoản sang thẻ khác: user mới ở thẻ đích, chép token, xoá dòng cũ; tài khoản đầu của thẻ / Boss / bận → từ chối', async () => {
    const agyWorker = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'antigravity-cli')!;
    const claudeWorker = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'claude-code' && !cfg.agents[a]!.provider)!;
    await post('/api/accounts/import', { file: [{ email: 'm@x.io', refresh_token: AGY_RT }] });
    const token = JSON.stringify({ token: { refresh_token: AGY_RT }, id_token_email: 'm@x.io' });
    const exec2 = (_f: string, args: string[], o?: { input?: string }) => { execCalls.push({ args, input: o?.input }); return Buffer.from(args.includes('cat') ? token : ''); };
    await new Promise((r) => server.close(r));
    server = createServer({ cfg, store, host: { busy: () => false } as any, webFile: resolve(__dirname, '../web/index.html'), pollMs: 50, accountExec: exec2 as any, loginSpawn: (() => ({})) as any });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    expect((await post(`/api/accounts/${agyWorker}/move`, { agent: claudeWorker })).status).toBe(400); // tài khoản đầu của thẻ
    expect((await post(`/api/accounts/${agyWorker}-m/move`, { agent: 'mb' })).status).toBe(400); // Boss
    expect((await post(`/api/accounts/${agyWorker}-m/move`, { agent: agyWorker })).status).toBe(400);
    execCalls.length = 0;
    const r = await post(`/api/accounts/${agyWorker}-m/move`, { agent: claudeWorker });
    expect(r.status).toBe(200);
    expect((await r.json()).key).toBe(`${claudeWorker}-m`);
    expect(store.getAccount(agyWorker, 'm')).toBeNull();
    expect(store.getAccount(claudeWorker, 'm')).toMatchObject({ email: 'm@x.io', tool: 'antigravity-cli', active: false });
    expect(execCalls.some((c) => c.args.includes('add') && c.args.includes(`btm-${claudeWorker}-m`))).toBe(true);
    const wrote = execCalls.filter((c) => c.input).map((c) => [c.args.find((a) => a.startsWith('btm-')), Object.values(JSON.parse(c.input!))[0]]);
    expect(wrote).toEqual([[`btm-${claudeWorker}-m`, token], [`btm-${agyWorker}-m`, '{}']]); // token cũ bị làm rỗng
  });

  it('model theo công cụ trong thẻ: /api/agent có tool → lưu riêng; snapshot có toolModels + canSit; runner dùng model của công cụ đó', async () => {
    const finn = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'claude-code' && !cfg.agents[a]!.provider)!;
    store.addAccount(finn, 'agy', { active: true, tool: 'antigravity-cli' });
    expect((await post('/api/agent', { agent: finn, tool: 'antigravity-cli', model: 'gemini-3.8-flash-high' })).status).toBe(200);
    expect((await post('/api/agent', { agent: finn, model: 'opus' })).status).toBe(200);
    expect(store.getSetting(`agent_model:${finn}:antigravity-cli`)).toBe('gemini-3.8-flash-high');
    expect(store.getSetting(`agent_model:${finn}`)).toBe('opus');
    const card = buildSnapshot(store, cfg).accounts.find((a) => a.agent === finn)!;
    expect(card.model).toBe('opus');
    expect(card.canSit).toEqual(cfg.agents[finn]!.can_sit);
    expect(card.toolModels).toEqual([{ tool: 'antigravity-cli', model: 'gemini-3.8-flash-high', effort: null, modelOptions: [] }]);
    const argvs: string[][] = [];
    const runProc = vi.fn(async (argv: string[]) => { argvs.push(argv); return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' } as any; });
    const runner = makeRunner({ ...cfg, host: { ...cfg.host, worker_prefix: '' } } as Config, undefined, runProc as any, () => {}, undefined, store, (k) => (k === `${finn}-agy` ? 'antigravity-cli' : 'claude-code'));
    await runner('pm', finn, 'làm', process.cwd(), 'logs/m.log', { account: `${finn}-agy` });
    expect(argvs[0].join(' ')).toContain("--model 'gemini-3.8-flash-high'");
    expect(argvs[0].join(' ')).not.toContain('--effort');
  });

  it('snapshot: mỗi tài khoản có công cụ; thẻ ghế PM của Worker Claude chạy bằng tài khoản agy khi Claude hết hạn mức; thẻ QC vẫn Claude', () => {
    const finn = Object.keys(cfg.agents).find((a) => cfg.agents[a]!.tool === 'claude-code' && !cfg.agents[a]!.provider && cfg.agents[a]!.can_sit.includes('pm'))!;
    store.addAccount(finn, 'agy', { active: true, tool: 'antigravity-cli' });
    const snap = buildSnapshot(store, cfg);
    const card = snap.accounts.find((a) => a.agent === finn)!;
    expect(card.tool).toBe('claude-code'); // công cụ chính của Worker (ô chọn model)
    expect(card.accounts.map((a) => `${a.slug}:${a.tool}`)).toEqual(['default:claude-code', 'agy:antigravity-cli']);
    store.setSetting(`usage_limited_until:${finn}`, new Date(Date.now() + 3600e3).toISOString());
    const limited = buildSnapshot(store, cfg);
    const pm = limited.seats.find((s) => s.agent === finn && s.seat === 'pm');
    if (pm) expect(pm.tool).toBe('antigravity-cli');
    const qc = limited.seats.find((s) => s.agent === finn && s.seat === 'qc');
    if (qc) expect(qc.tool).not.toBe('antigravity-cli');
  });

  it('giao diện: ô Công cụ khi thêm tài khoản, nhãn công cụ trên tài khoản khác công cụ chính; đăng nhập theo công cụ của tài khoản', () => {
    const html = readWeb();
    expect(html).toContain('id="acc-add-tool"');
    expect(html).toContain("if (accAddTool && accAddTool.value && accAddTool.value !== workerTool(accAddWorker.value)) body.tool = accAddTool.value;");
    expect(html).toContain("var accTool = a.tool || worker.tool;");
    expect(html).toContain("toolTag.className = 'acc-tool-tag';");
    expect(html).toContain("var cmd = getLoginCommand(accTool, sshTarget, a.user);");
    expect(html).toContain("'acc.toolTip': 'This account runs on {tool}.");
  });
});
