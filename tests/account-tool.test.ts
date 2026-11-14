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
import { canRunOnSeat, pickAccount, toolOfAccount, toolOfAccountKey, usableAccounts } from '../src/agents/accounts.ts';
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

  it('theo thứ tự anh xếp: Claude hết hạn mức thì Finn dùng Antigravity; ghế chỉ đọc (QC/Audit) luôn bỏ Antigravity', () => {
    const store = seed();
    const cfg = cfgOf();
    const now = new Date('2026-11-14T10:00:00Z');
    expect(usableAccounts(cfg, store, 'finn', now).map((a) => a.key)).toEqual(['finn', 'finn-agy']);
    expect(pickAccount(cfg, store, 'finn', now)!.key).toBe('finn');
    store.setSetting('usage_limited_until:finn', new Date(now.getTime() + 3600e3).toISOString());
    expect(pickAccount(cfg, store, 'finn', now)!.key).toBe('finn-agy'); // ghế PM/Dev: chạy tiếp bằng Antigravity
    expect(pickAccount(cfg, store, 'finn', now, { readOnly: true })).toBeNull(); // ghế QC: chỉ đọc → không dùng agy
    store.setSetting('usage_limited_until:finn', '');
    expect(usableAccounts(cfg, store, 'finn', now, { readOnly: true }).map((a) => a.key)).toEqual(['finn']);
    expect(canRunOnSeat('antigravity-cli', 'qc', 'claude-code')).toBe(false); // tài khoản agy thêm cho Worker Claude
    expect(canRunOnSeat('antigravity-cli', 'audit', 'codex-cli')).toBe(false);
    expect(canRunOnSeat('antigravity-cli', 'dev', 'claude-code')).toBe(true);
    expect(canRunOnSeat('claude-code', 'qc', 'claude-code')).toBe(true);
    // Worker agy gốc: config.ts đã cấm ngồi QC/Audit, nên không chặn thêm ở đây (giữ hành vi cũ)
    expect(canRunOnSeat('antigravity-cli', 'qc', 'antigravity-cli')).toBe(true);
    expect(usableAccounts(cfg, store, 'john', now, { readOnly: true }).map((a) => a.key)).toEqual(['john']);
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

  it('ghế chỉ đọc chọn nhầm tài khoản agy → từ chối, không chạy gì', async () => {
    const { argvs, runner } = make(() => 'antigravity-cli');
    await expect(runner('qc', 'finn', 'kiểm', process.cwd(), 'logs/c.log', { account: 'finn-agy' })).rejects.toThrow(/agy_cannot_sit_read_only/);
    await expect(runner('audit', 'finn', 'kiểm', process.cwd(), 'logs/d.log', { account: 'finn-agy' })).rejects.toThrow(/agy_cannot_sit_read_only/);
    expect(argvs).toHaveLength(0);
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
