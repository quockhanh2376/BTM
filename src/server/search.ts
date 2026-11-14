// Ô Search của dashboard (anh Zon 2026-11-14): tìm nhanh trong dữ liệu BTM, không AI, không lưu gì.
// Nguồn: goal + ticket, hỏi–đáp / lệnh, nhật ký goal (kho kiến thức), log phiên gần nhất. Goal trong thùng rác bị bỏ qua.
// Tìm không phân biệt hoa thường, có dấu / không dấu ("mua" khớp "mưa", "do" khớp "đỏ").
import type { Store } from '../store/db.ts';
import type { Config } from '../config.ts';
import { buildSnapshot } from './snapshot.ts';
import { readAnswers } from './ask-lane.ts';
import { buildGoalDigest } from '../knowledge/digest.ts';
import { projectLessonsFile, readLessons, sharedLessonsFile } from '../knowledge/lessons.ts';
import { buildProjectMap } from '../knowledge/map.ts';

export type SearchKind = 'goal' | 'ticket' | 'qa' | 'history' | 'log' | 'lesson' | 'map';
export interface SearchHit { kind: SearchKind; title: string; text: string; at?: string }

export const SEARCH_MAX_HITS = 30;
const SNIPPET = 240;
const GOAL_SUMMARY = 800;

/** Bỏ dấu + chữ thường, giữ nguyên độ dài (mỗi ký tự → 1 ký tự) để cắt đoạn trích đúng chỗ. */
export function foldText(s: string): string {
  let out = '';
  for (const ch of s) {
    const f = ch === 'đ' || ch === 'Đ' ? 'd' : ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    out += f.length === ch.length ? f : ch.length === 1 ? (f[0] ?? ch) : ch;
  }
  return out;
}

function snippet(text: string, folded: string, term: string): string {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  const i = term ? folded.indexOf(term) : 0;
  if (text.length <= SNIPPET) return flat(text);
  const a = Math.max(0, i - 60);
  return (a > 0 ? '…' : '') + flat(text.slice(a, a + SNIPPET)) + (a + SNIPPET < text.length ? '…' : '');
}

/** Tìm trong danh sách mục: mọi từ của câu tìm phải có mặt (AND). G<n> trong câu tìm xử lý riêng ở searchBtm. */
export function matchItems(items: SearchHit[], terms: string[]): SearchHit[] {
  if (!terms.length) return [];
  const out: SearchHit[] = [];
  for (const it of items) {
    const folded = foldText(it.title + '\n' + it.text);
    if (!terms.every((t) => folded.includes(t))) continue;
    const body = foldText(it.text);
    const first = terms.find((t) => body.includes(t)) ?? '';
    out.push({ ...it, text: snippet(it.text, body, first) });
  }
  return out;
}

export function searchBtm(store: Store, cfg: Config, query: string): SearchHit[] {
  const q = String(query || '').slice(0, 200);
  const project = store.getActiveProject();
  if (!project || !q.trim()) return [];
  const snap = buildSnapshot(store, cfg);
  const goals = snap.goals; // chỉ goal còn trên bảng (không gồm thùng rác)
  const named = new Set([...q.matchAll(/\bG(\d{1,6})\b/gi)].map((m) => parseInt(m[1]!, 10)));
  const terms = foldText(q.replace(/\bG\d{1,6}\b/gi, ' ')).split(/[\s,.;:!?()"'`]+/).filter((t) => t.length >= 2);

  const hits: SearchHit[] = [];
  // Goal được nhắc tên (G1…) → luôn hiện goal + đầu nhật ký (trả lời "G1 là gì").
  for (const g of goals) {
    if (!named.has(g.n)) continue;
    hits.push({ kind: 'goal', title: `G${g.n} · ${g.title}`, text: `${g.state} · ${g.passed}/${g.total} tickets passed` });
    const d = buildGoalDigest(store, cfg, project, g.n);
    if (d) hits.push({ kind: 'history', title: `G${g.n} history`, text: d.length > GOAL_SUMMARY ? d.slice(0, GOAL_SUMMARY) + '…' : d });
  }

  const items: SearchHit[] = [];
  for (const g of goals) {
    if (!named.has(g.n)) items.push({ kind: 'goal', title: `G${g.n} · ${g.title}`, text: `${g.state} · ${g.passed}/${g.total} tickets passed` });
    for (const t of g.tickets) items.push({ kind: 'ticket', title: `${t.id} · G${g.n}`, text: `${t.title} · ${t.state}${t.fix_rounds ? ` · ${t.fix_rounds} fix rounds` : ''}` });
  }
  const answered = new Set<number>();
  for (const a of readAnswers(store, project)) {
    answered.add(a.id);
    items.push({ kind: 'qa', title: `${a.question.slice(0, 80)} → ${a.seat}`, text: a.answer, at: a.at });
  }
  for (const it of snap.queue) {
    if (!answered.has(it.id)) items.push({ kind: 'qa', title: `Command → ${it.to} · ${it.status}`, text: it.text, at: it.created_at });
  }
  for (const g of goals) {
    if (named.has(g.n)) continue;
    const d = buildGoalDigest(store, cfg, project, g.n);
    if (d) items.push({ kind: 'history', title: `G${g.n} history`, text: d });
  }
  const lessonLines = new Set([projectLessonsFile(cfg.host.data_dir, project) ?? '', sharedLessonsFile(cfg.host.data_dir)]
    .flatMap((f) => (f ? readLessons(f) : '').split(/\r?\n/).filter((l) => l.startsWith('- '))));
  for (const l of lessonLines) items.push({ kind: 'lesson', title: 'Lesson', text: l.slice(2) });
  // Bản đồ project: mỗi file một mục (tìm "logic.js", tên hàm, ticket đã sửa).
  for (const l of buildProjectMap(store, project).split(/\r?\n/)) {
    if (l.startsWith('- ') && !/^- G\d+ /.test(l)) items.push({ kind: 'map', title: 'Map', text: l.slice(2) });
  }
  // shortcut: chỉ log của phiên gần nhất (50 dòng như Snapshot); lỗi phiên cũ đã nằm trong nhật ký goal.
  for (const l of snap.log) items.push({ kind: 'log', title: l.who, text: l.text, at: l.at });

  // Câu tìm chỉ có G<n> (hoặc thêm vài chữ không khớp) vẫn trả goal đó; các mục khác cần khớp mọi từ.
  const found = matchItems(items, terms);
  return [...hits, ...found].slice(0, SEARCH_MAX_HITS);
}
