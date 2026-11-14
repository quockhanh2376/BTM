// Bản đồ kiến thức project (anh Zon 2026-11-14): module có sẵn, spec, ticket nào từng sửa file nào.
// Core tự dựng từ checkout (không AI, không commit). Spec: docs/superpowers/specs/2026-11-14-project-map-design.md
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import { git } from '../git.ts';
import { parseTicket, type Ticket } from '../ticket/ticket.ts';
import { readProjectKey } from '../ticket/goal.ts';

export const MAP_PM_MAX = 4000;
export const MAP_DEV_MAX = 1500;
export const MAP_FILE_MAX = 12000;
const MAX_FILES = 400;
const READ_BYTES = 64 * 1024;
const SKIP = /^(team\/|node_modules\/|\.git\/)|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp3|mp4|wav|zip|gz|pdf|lock)$/i;
const CODE = /\.(m?[jt]sx?|cjs|py)$/i;

const one = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Dòng chú thích đầu + tên hàm/class được export (JS/TS: export …, module.exports, exports.x; Python: def/class cấp đầu). */
export function fileSymbols(text: string, path: string): { note: string; symbols: string[] } {
  const lines = text.split(/\r?\n/).slice(0, 400);
  const first = lines.find((l) => /^\s*(\/\/|#(?!!)|\/\*|\*|""")/.test(l) && one(l.replace(/^\s*(\/\/+|#+|\/\*+|\*+|""")\s*/, ''), 200));
  const note = first ? one(first.replace(/^\s*(\/\/+|#+|\/\*+|\*+|""")\s*/, '').replace(/\*\/\s*$/, ''), 110) : '';
  if (!CODE.test(path)) return { note, symbols: [] };
  const found = new Set<string>();
  const add = (n?: string) => { if (n && found.size < 10) found.add(n); };
  if (/\.py$/i.test(path)) {
    for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) if (!m[1]!.startsWith('_')) add(m[1]);
  } else {
    for (const m of text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
    for (const m of text.matchAll(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm)) add(m[1]);
    const me = /module\.exports\s*=\s*\{([^}]*)\}/.exec(text);
    if (me) for (const part of me[1]!.split(',')) add(/^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1]);
    if (!found.size) for (const m of text.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  }
  return { note, symbols: [...found] };
}

/** Ticket của project (đọc từng file, ticket lỗi thì bỏ qua). */
function readTickets(repo: string, key: string): Ticket[] {
  const dir = join(repo, 'team', 'tickets');
  if (!existsSync(dir)) return [];
  const out: Ticket[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try { out.push(parseTicket(readFileSync(join(dir, f), 'utf8'), key)); } catch { /* ticket lỗi: bỏ qua */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
const covers = (scope: string, file: string) => { const s = norm(scope); return s.endsWith('/') ? file.startsWith(s) : file === s; };

/** file → ["GT-0002 (G1)", …] theo scope của các ticket. */
export function touchedBy(tickets: Ticket[]): (file: string) => string[] {
  return (file) => tickets.filter((t) => t.scope.some((s) => covers(s, file))).map((t) => `${t.id} (${t.goal})`);
}

function trackedFiles(repo: string): string[] {
  try {
    return git(repo, 'ls-files').split(/\r?\n/).map(norm).filter((f) => f && !SKIP.test(f)).slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

function readHead(repo: string, file: string): string {
  try {
    const p = join(repo, file);
    if (statSync(p).size > 4 * READ_BYTES) return '';
    const buf = readFileSync(p);
    const head = buf.subarray(0, READ_BYTES);
    return head.includes(0) ? '' : head.toString('utf8');
  } catch {
    return '';
  }
}

function fileLine(repo: string, file: string, by: (f: string) => string[]): string {
  const { note, symbols } = fileSymbols(readHead(repo, file), file);
  const touched = by(file);
  return `- ${file}${note ? ` — ${note}` : ''}${symbols.length ? ` · có: ${symbols.join(', ')}` : ''}${touched.length ? ` · sửa bởi: ${touched.slice(-4).join(', ')}` : ''}`;
}

function readmeLine(repo: string): string {
  const text = readHead(repo, 'README.md');
  const line = text.split(/\r?\n/).find((l) => l.trim() && !/^\s*(#|!\[|<|```|---)/.test(l));
  return line ? one(line, 200) : '';
}

/** Bản đồ cả project: spec (README + goal) rồi module. Lỗi → chuỗi rỗng. */
export function buildProjectMap(store: Store, repo: string, max = MAP_FILE_MAX): string {
  try {
    const key = readProjectKey(repo);
    const tickets = readTickets(repo, key);
    const by = touchedBy(tickets);
    const lines = [`# Bản đồ project ${key}`];
    const readme = readmeLine(repo);
    if (readme) lines.push(`Mô tả (README): ${readme}`);
    const goals = store.listGoals(repo).filter((g) => !g.archived_at);
    if (goals.length) {
      lines.push('', '## Goal');
      for (const g of goals) lines.push(`- G${g.n} ${one(g.title, 90)} → ${g.state}, ${tickets.filter((t) => t.goal === `G${g.n}`).length} ticket`);
    }
    lines.push('', '## Module (file · mô tả · hàm có sẵn · ticket đã sửa)');
    for (const f of trackedFiles(repo)) lines.push(fileLine(repo, f, by));
    return cut(lines.join('\n'), max);
  } catch {
    return '';
  }
}

/** Phần bản đồ cho Dev: các file trong scope ticket (thư mục → mọi file trong đó). */
export function mapForScope(repo: string, scope: string[], max = MAP_DEV_MAX): string {
  try {
    const by = touchedBy(readTickets(repo, readProjectKey(repo)));
    const files = trackedFiles(repo).filter((f) => scope.some((s) => covers(s, f)));
    return cut(files.map((f) => fileLine(repo, f, by)).join('\n'), max);
  } catch {
    return '';
  }
}

/** Ticket khác (cũ hơn) có scope trùng file với ticket này → QC kiểm lại để bắt lỗi hồi quy. */
export function regressionTickets(repo: string, t: Ticket): string[] {
  try {
    const others = readTickets(repo, readProjectKey(repo)).filter((x) => x.id !== t.id && x.id < t.id);
    const mine = t.scope.map(norm);
    return others.filter((o) => o.scope.some((s) => mine.some((m) => covers(s, m) || covers(m, norm(s)) || norm(s) === m))).map((o) => o.id);
  } catch {
    return [];
  }
}

/** Lưu bản mới nhất ra <data_dir>/knowledge/<KEY>/map.md (ngoài git). */
export function saveProjectMap(store: Store, cfg: Config, repo: string): string | null {
  try {
    const text = buildProjectMap(store, repo);
    if (!text) return null;
    const dir = join(cfg.host.data_dir, 'knowledge', readProjectKey(repo));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'map.md');
    writeFileSync(file, text + '\n', { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}
