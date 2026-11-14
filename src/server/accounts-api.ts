import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Config, Tool } from '../config.ts';
import type { AccountLabel, Store } from '../store/db.ts';
import { accountKey, toolOfAccount, validateSlug } from '../agents/accounts.ts';
import { addWorkerUser, agyFilesFromJson, emailFromTokens, exportTokens, importTokens, TOKEN_FILES, type AdminExec } from '../isolation/account-admin.ts';
import { loginState, sendLoginCode, startLogin, type SpawnFn } from '../agents/login-flow.ts';
import { isIsolated } from '../isolation/trusted.ts';

// Plan 7 Task 4: API tài khoản. Không bao giờ đưa token vào response (trừ /export), log hay thông báo lỗi.

export interface AccountsCtx {
  cfg: Config;
  store: Store;
  busy: () => boolean;
  exec?: AdminExec;
  spawn?: SpawnFn;
}

type Send = (res: ServerResponse, status: number, data: unknown) => void;

const LABELS = ['none', 'ide', 'cli', 'plugin', 'other'] as const;
const KEY_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** Khoá tài khoản → {agent, slug} theo kho (không đoán từ chuỗi: agent id có thể chứa '-'). */
function findAccount(cfg: Config, store: Store, key: string): { agent: string; slug: string } | null {
  for (const a of store.listAccounts()) if (cfg.agents[a.agent] && accountKey(a.agent, a.slug) === key) return { agent: a.agent, slug: a.slug };
  return null;
}

const EntrySchema = z.object({
  agent: z.string(),
  slug: z.string(),
  tool: z.string(),
  email: z.string().max(256).nullable().optional(),
  label: z.enum(LABELS).optional(),
  files: z.record(z.string(), z.string()),
});
const FileSchema = z.object({ version: z.literal(1), accounts: z.array(z.unknown()).max(200) });
// Định dạng chung với danh sách tài khoản Antigravity của anh Zon: [{email, refresh_token}, …].
// Mục BTM đầy đủ (claude/codex) nằm chung mảng, giữ dạng {agent, slug, tool, files}.
const ListSchema = z.array(z.unknown()).max(200);
const AgyShortSchema = z.object({ email: z.string().max(256), refresh_token: z.string().max(4096), agent: z.string().max(40).optional() });

/** Slug từ phần trước @ của email: chỉ a-z0-9, tối đa 12 ký tự. */
function slugFromEmail(email: string): string {
  return (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

/** {email, refresh_token} → mục BTM cho Worker agy (ghi rõ `agent`, hoặc Worker agy duy nhất trên máy).
 *  Email đã có ở Worker đó → trùng vào đúng tài khoản ấy; chưa có → slug từ email. */
function agyShortToEntry(cfg: Config, store: Store, raw: { email: string; refresh_token: string; agent?: string }, target?: string) {
  const agy = Object.keys(cfg.agents).filter((id) => cfg.agents[id]!.tool === 'antigravity-cli');
  // Worker đích: ghi trong mục > Worker anh chọn khi nhập (anh Zon 2026-11-14: acc cho Finn, không phải John) > Worker agy duy nhất.
  const agent = raw.agent ?? target ?? (agy.length === 1 ? agy[0]! : null);
  if (!agent) return { reason: agy.length ? 'several agy Workers – add "agent" to the entry' : 'no agy Worker on this machine' };
  if (!cfg.agents[agent]) return { reason: 'unknown worker on this machine' };
  let files: Record<string, string>;
  try {
    files = agyFilesFromJson(raw);
  } catch (err) {
    return { reason: (err as Error).message };
  }
  const same = store.listAccounts(agent).find((a) => a.email === raw.email);
  if (!same && store.getAccount(agent, slugFromEmail(raw.email))) return { reason: 'name taken by another account' };
  return { entry: { agent, slug: same ? same.slug : slugFromEmail(raw.email), tool: 'antigravity-cli', email: raw.email, files } };
}

const toolIfOther = (cfg: Config, agent: string, tool: Tool): Tool | null => (cfg.agents[agent]?.tool === tool ? null : tool);

type Planned = { key: string; agent: string; slug: string; tool: Tool; email: string | null; label: AccountLabel; files: Record<string, string> };

function planImport(cfg: Config, store: Store, file: unknown, target?: string) {
  const list = ListSchema.safeParse(file);
  const parsed = list.success ? null : FileSchema.safeParse(file);
  if (!list.success && !parsed!.success) return { error: 'not an accounts file ([{email, refresh_token}, …])' } as const;
  const items = list.success ? list.data : parsed!.data!.accounts;
  const fresh: Planned[] = [];
  const conflicts: Planned[] = [];
  const rejected: Array<{ entry: string; reason: string }> = [];
  items.forEach((item, i) => {
    let raw = item;
    const short = AgyShortSchema.safeParse(item);
    if (short.success && !(item as { files?: unknown }).files) {
      const r = agyShortToEntry(cfg, store, short.data, target);
      if ('reason' in r) return rejected.push({ entry: `#${i + 1}`, reason: r.reason! });
      raw = r.entry;
    }
    const e = EntrySchema.safeParse(raw);
    if (!e.success) return rejected.push({ entry: `#${i + 1}`, reason: 'bad entry' });
    const { agent, slug, tool } = e.data;
    const name = /^[a-z0-9-]{1,40}$/.test(`${agent}`) && /^[a-z0-9]{1,12}$/.test(slug) ? `${agent}/${slug}` : `#${i + 1}`;
    const worker = cfg.agents[agent];
    if (!worker) return rejected.push({ entry: name, reason: 'unknown worker on this machine' });
    if (!Object.hasOwn(TOKEN_FILES, tool)) return rejected.push({ entry: name, reason: `unknown tool (${tool})` });
    if (worker.provider === 'zai') return rejected.push({ entry: name, reason: 'Boss uses an API key, it has no login accounts' });
    if (slug !== 'default') {
      const bad = validateSlug(cfg, agent, slug);
      if (bad) return rejected.push({ entry: name, reason: bad });
    }
    const allowed = new Set(TOKEN_FILES[tool as Tool]);
    const files = Object.entries(e.data.files);
    if (files.length === 0 || files.some(([rel, text]) => !allowed.has(rel) || text.length === 0 || text.length > 64 * 1024)) {
      return rejected.push({ entry: name, reason: 'files not allowed for this tool' });
    }
    const p: Planned = { key: accountKey(agent, slug), agent, slug, tool: tool as Tool, email: e.data.email ?? null, label: e.data.label ?? 'none', files: e.data.files };
    if ([...fresh, ...conflicts].some((x) => x.key === p.key)) return rejected.push({ entry: name, reason: 'duplicate in file' });
    (store.getAccount(agent, slug) ? conflicts : fresh).push(p);
  });
  return { fresh, conflicts, rejected } as const;
}

export function handleAccountsGet(pathname: string, ctx: AccountsCtx, res: ServerResponse, send: Send): boolean {
  const m = pathname.match(/^\/api\/accounts\/login\/([0-9a-f]{16})$/);
  if (!m) return false;
  const view = loginState(m[1]!);
  if (!view) send(res, 404, { error: 'No such login' });
  else send(res, 200, view);
  return true;
}

export function handleAccountsPost(pathname: string, body: unknown, ctx: AccountsCtx, res: ServerResponse, send: Send): boolean {
  if (!pathname.startsWith('/api/accounts')) return false;
  const { cfg, store } = ctx;

  const codeM = pathname.match(/^\/api\/accounts\/login\/([0-9a-f]{16})\/code$/);
  if (codeM) {
    const p = z.object({ code: z.string().min(1).max(200) }).safeParse(body);
    if (!p.success) return send(res, 400, { error: 'Invalid code' }), true;
    try {
      sendLoginCode(codeM[1]!, p.data.code.trim());
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 409, { error: (err as Error).message });
    }
    return true;
  }

  if (pathname === '/api/accounts/export') {
    if (!isIsolated(cfg)) return send(res, 409, { error: 'isolation required' }), true;
    const accounts = store.listAccounts().filter((a) => cfg.agents[a.agent]).map((a) => {
      const tool = toolOfAccount(cfg, store, a.agent, a.slug);
      const key = accountKey(a.agent, a.slug);
      const files = exportTokens(cfg, key, tool, ctx.exec);
      if (tool === 'antigravity-cli') {
        // agy: cùng định dạng danh sách Antigravity [{email, refresh_token}]; đọc không ra → giữ mục đầy đủ.
        try {
          const t = JSON.parse(files[TOKEN_FILES['antigravity-cli'][0]!] ?? '');
          const email = a.email ?? t.id_token_email;
          if (typeof email === 'string' && typeof t.token?.refresh_token === 'string') return cfg.agents[a.agent]!.tool === 'antigravity-cli' ? { email, refresh_token: t.token.refresh_token } : { email, refresh_token: t.token.refresh_token, agent: a.agent };
        } catch {
          /* giữ mục đầy đủ */
        }
      }
      return { agent: a.agent, slug: a.slug, tool, email: a.email, label: a.label, files };
    });
    const payload = JSON.stringify(accounts, null, 2);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="btm-accounts-${day}.json"`,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
    return true;
  }

  if (pathname === '/api/accounts/import') {
    const p = z.object({ file: z.unknown(), overwrite: z.array(z.string().max(64)).max(200).optional(), dryRun: z.boolean().optional(), agent: z.string().max(40).optional() }).safeParse(body);
    if (!p.success) return send(res, 400, { error: 'Invalid body' }), true;
    if (!isIsolated(cfg)) return send(res, 409, { error: 'isolation required' }), true;
    if (ctx.busy()) return send(res, 409, { error: 'Session running' }), true;
    if (p.data.agent && (!Object.hasOwn(cfg.agents, p.data.agent) || cfg.agents[p.data.agent]!.provider === 'zai')) return send(res, 400, { error: 'Unknown Worker for the import target' }), true;
    const plan = planImport(cfg, store, p.data.file, p.data.agent);
    if ('error' in plan) return send(res, 400, { error: plan.error }), true;
    const summary = {
      new: plan.fresh.map((x) => `${x.agent}/${x.slug}`),
      conflicts: plan.conflicts.map((x) => `${x.agent}/${x.slug}`),
      rejected: plan.rejected,
    };
    if (p.data.dryRun) return send(res, 200, summary), true;
    const over = new Set(p.data.overwrite ?? []);
    const done: string[] = [];
    const failed: Array<{ entry: string; reason: string }> = [];
    for (const x of [...plan.fresh, ...plan.conflicts.filter((c) => over.has(`${c.agent}/${c.slug}`))]) {
      try {
        if (x.slug !== 'default') addWorkerUser(cfg, x.key, ctx.exec);
        importTokens(cfg, x.key, x.tool, x.files, ctx.exec);
        const email = x.email ?? emailFromTokens(x.tool, x.files);
        if (store.getAccount(x.agent, x.slug)) store.updateAccount(x.agent, x.slug, { email, label: x.label });
        else store.addAccount(x.agent, x.slug, { email, label: x.label, active: false, tool: toolIfOther(cfg, x.agent, x.tool) });
        done.push(`${x.agent}/${x.slug}`);
      } catch (err) {
        failed.push({ entry: `${x.agent}/${x.slug}`, reason: (err as Error).message });
      }
    }
    send(res, 200, { ...summary, imported: done, failed });
    return true;
  }

  if (pathname === '/api/accounts') {
    const p = z
      .object({
        agent: z.string().max(40),
        slug: z.string().max(40),
        /** Công cụ của tài khoản (mặc định: công cụ của Worker). Anh Zon 2026-11-14: một member dùng nhiều công cụ. */
        tool: z.enum(['claude-code', 'codex-cli', 'antigravity-cli']).optional(),
        agy: z.object({ email: z.string().max(256), refresh_token: z.string().max(4096) }).optional(),
      })
      .safeParse(body);
    if (!p.success) return send(res, 400, { error: 'Invalid body' }), true;
    if (!isIsolated(cfg)) return send(res, 409, { error: 'isolation required' }), true;
    if (ctx.busy()) return send(res, 409, { error: 'Session running' }), true;
    const { agent, slug } = p.data;
    const bad = validateSlug(cfg, agent, slug);
    if (bad) return send(res, 400, { error: bad }), true;
    if (store.getAccount(agent, slug)) return send(res, 409, { error: 'Account exists' }), true;
    const tool: Tool = p.data.tool ?? cfg.agents[agent]!.tool;
    const key = accountKey(agent, slug);
    let files: Record<string, string> | null = null;
    if (tool === 'antigravity-cli') {
      try {
        files = agyFilesFromJson(p.data.agy);
      } catch (err) {
        return send(res, 400, { error: (err as Error).message }), true;
      }
    }
    try {
      addWorkerUser(cfg, key, ctx.exec);
      if (files) {
        importTokens(cfg, key, tool, files, ctx.exec);
        store.addAccount(agent, slug, { email: emailFromTokens(tool, files), active: true, tool: toolIfOther(cfg, agent, tool) });
        return send(res, 200, { key, loginId: null }), true;
      }
    } catch (err) {
      return send(res, 500, { error: (err as Error).message }), true;
    }
    // claude/codex: chỉ bật tài khoản khi đăng nhập xong; đang có đăng nhập khác → 409, chưa tạo dòng nào.
    let login: { id: string };
    try {
      login = startLogin(cfg, key, tool, ctx.spawn, () => store.updateAccount(agent, slug, { active: true }));
    } catch (err) {
      return send(res, 409, { error: (err as Error).message }), true;
    }
    store.addAccount(agent, slug, { email: null, active: false, tool: toolIfOther(cfg, agent, tool) });
    send(res, 200, { key, loginId: login.id });
    return true;
  }

  // Đăng nhập lại tài khoản có sẵn (claude/codex): xong thì bật.
  const reloginM = pathname.match(/^\/api\/accounts\/([^/]+)\/login$/);
  if (reloginM && KEY_RE.test(reloginM[1]!)) {
    if (!isIsolated(cfg)) return send(res, 409, { error: 'isolation required' }), true;
    if (ctx.busy()) return send(res, 409, { error: 'Session running' }), true;
    const acc = findAccount(cfg, store, reloginM[1]!);
    if (!acc) return send(res, 404, { error: 'No such account' }), true;
    const tool = toolOfAccount(cfg, store, acc.agent, acc.slug);
    if (tool === 'antigravity-cli') return send(res, 400, { error: 'agy: add the account again from JSON or sign in over ssh' }), true;
    try {
      const login = startLogin(cfg, reloginM[1]!, tool, ctx.spawn, () => store.updateAccount(acc.agent, acc.slug, { active: true }));
      send(res, 200, { key: reloginM[1], loginId: login.id });
    } catch (err) {
      send(res, 409, { error: (err as Error).message });
    }
    return true;
  }

  const editM = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (editM && KEY_RE.test(editM[1]!)) {
    const p = z
      .object({ label: z.enum(LABELS).optional(), active: z.boolean().optional(), move: z.enum(['up', 'down']).optional() })
      .safeParse(body);
    if (!p.success) return send(res, 400, { error: 'Invalid body' }), true;
    const acc = findAccount(cfg, store, editM[1]!);
    if (!acc) return send(res, 404, { error: 'No such account' }), true;
    if ((p.data.active !== undefined || p.data.move) && ctx.busy()) return send(res, 409, { error: 'Session running' }), true;
    if (p.data.label !== undefined || p.data.active !== undefined) store.updateAccount(acc.agent, acc.slug, { label: p.data.label, active: p.data.active });
    if (p.data.move) store.moveAccount(acc.agent, acc.slug, p.data.move);
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}
