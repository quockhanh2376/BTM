import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import { git } from '../git.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { readRelease } from '../release/publish.ts';
import { goalTime } from '../server/snapshot.ts';

// Kho kiến thức team (anh Zon 2026-11-14, bước 2). Spec: docs/superpowers/specs/2026-11-14-team-chat-knowledge-design.md
// Nhật ký nén của một goal, dựng từ dữ liệu sẵn có (DB + báo cáo audit), KHÔNG gọi AI. Dán vào prompt khi anh hỏi.

export const DIGEST_MAX = 4000;
export const KNOWLEDGE_MAX = 9000;

const vn = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
const dur = (ms: number) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`; };
const one = (s: string | null | undefined, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Đọc báo cáo audit của goal (nhánh goal, rồi main). */
function auditReport(project: string, branch: string, main: string, n: number): string {
  for (const ref of [`refs/heads/${branch}`, `refs/heads/${main}`]) {
    try { return git(project, 'show', `${ref}:team/reports/G${n}-audit.md`); } catch { /* chưa có */ }
  }
  return '';
}

export function buildGoalDigest(store: Store, cfg: Config, project: string, n: number): string | null {
  const g = store.getGoal(project, n);
  if (!g) return null;
  const tickets = store.listTickets(project, `G${n}`);
  const t = goalTime(g.created_at, g.state === 'merged' || g.state === 'approved' ? g.updated_at : null, store.goalTurns(project, n));
  const seats = Object.entries(t.bySeat).map(([k, v]) => `${k} ${dur(v)}`).join(', ');
  const lines: string[] = [
    `# G${n} · ${one(g.title, 160)}`,
    `Trạng thái: ${g.state}${g.archived_at ? ' (đã vào thùng rác)' : ''} · bắt đầu ${vn(g.created_at)} · ${t.endedAt ? `xong ${vn(t.endedAt)}` : 'đang mở'} (giờ VN) · tổng ${dur(t.wallMs)}, agent ${dur(t.agentMs)}${seats ? ` (${seats})` : ''}`,
    '',
    '## Ticket',
  ];
  for (const tk of tickets) {
    const back = store.ticketHistory(project, tk.id).filter((h) => h.to_state === 'returned' || h.to_state === 'failed' || h.to_state === 'blocked')
      .map((h) => one(h.reason, 60)).slice(-3);
    lines.push(`- ${tk.id} #${tk.number}/${tk.of} ${one(tk.title, 70)} → ${tk.state}, sửa ${tk.fix_rounds} vòng${back.length ? `; trả về vì: ${back.join(' | ')}` : ''}`);
  }
  const ids = new Set(tickets.map((x) => x.id));
  const qa = store.listQuestions(project).filter((q) => ids.has(q.ticket) && q.answer);
  if (qa.length) {
    lines.push('', '## Hỏi – đáp với anh Zon');
    for (const q of qa.slice(-8)) lines.push(`- ${q.ticket} hỏi: ${one(q.text, 110)} → đáp: ${one(q.answer, 140)}`);
  }
  const audit = auditReport(project, g.branch, cfg.git?.protected_branch || 'main', n);
  if (audit) {
    const body = audit.split(/\r?\n/).slice(1).filter((l) => l.trim()).join(' ');
    lines.push('', '## Audit bảo mật', one(body, 600));
  }
  const rel = readRelease(store, project, n);
  if (rel) lines.push('', `## Release: ${rel.ok ? 'ok' : `lỗi ${rel.error ?? ''}`} · ${rel.tag} · ${rel.url} · ${vn(rel.at)}`);
  lines.push('', `Báo cáo chi tiết: team/reports/<ID>-dev.md, <ID>-qc.json, G${n}-audit.md (nhánh ${g.branch}).`);
  const text = lines.join('\n');
  return text.length > DIGEST_MAX ? `${text.slice(0, DIGEST_MAX - 1)}…` : text;
}

/** Lưu nhật ký vào <data_dir>/knowledge/<KEY>/G<n>.md (ngoài git, không release). Lỗi ghi không làm hỏng luồng chính. */
export function saveGoalDigest(store: Store, cfg: Config, project: string, n: number): string | null {
  try {
    const text = buildGoalDigest(store, cfg, project, n);
    if (!text) return null;
    const dir = join(cfg.host.data_dir, 'knowledge', readProjectKey(project));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `G${n}.md`);
    writeFileSync(file, text + '\n', { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** Kiến thức đưa vào câu hỏi: các goal được nhắc (G<n>); không nhắc thì 2 goal mới nhất còn trên bảng. */
export function knowledgeFor(store: Store, cfg: Config, project: string, question: string): string {
  const goals = store.listGoals(project);
  const named = [...new Set([...question.matchAll(/\bG(\d{1,6})\b/gi)].map((m) => parseInt(m[1]!, 10)))]
    .filter((n) => goals.some((g) => g.n === n));
  const pick = named.length ? named : goals.filter((g) => !g.archived_at).map((g) => g.n).slice(-2).reverse();
  let out = '';
  for (const n of pick) {
    const d = buildGoalDigest(store, cfg, project, n);
    if (!d || out.length + d.length > KNOWLEDGE_MAX) continue;
    out += (out ? '\n\n' : '') + d;
  }
  return out;
}
