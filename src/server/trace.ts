// Truy vết ticket (anh Zon 2026-11-14): ai làm, bước nào, bao lâu, kết quả, log. Chỉ đọc dữ liệu sẵn có.
// Spec: docs/superpowers/specs/2026-11-14-ticket-trace-lessons-design.md
import { readFileSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import type { Store } from '../store/db.ts';

export type TraceEvent =
  | { kind: 'state'; at: string; by: string; from: string; to: string; reason: string }
  | { kind: 'turn'; id: number; at: string; endedAt: string | null; seat: string; agent: string; result: string | null; error: string | null; ms: number; hasLog: boolean };

export interface TraceTotals { turns: number; agentMs: number; bySeat: Record<string, number>; fixRounds: number; returns: number }

export function buildTicketTrace(store: Store, project: string, ticketId: string, now = Date.now()): { events: TraceEvent[]; totals: TraceTotals } {
  const events: TraceEvent[] = [];
  const totals: TraceTotals = { turns: 0, agentMs: 0, bySeat: {}, fixRounds: 0, returns: 0 };
  for (const h of store.ticketHistory(project, ticketId)) {
    events.push({ kind: 'state', at: h.at, by: h.by, from: h.from_state, to: h.to_state, reason: h.reason });
    if (h.to_state === 'returned') totals.returns++;
  }
  for (const t of store.ticketTurns(project, ticketId)) {
    const ms = Math.max(0, (t.ended_at ? Date.parse(t.ended_at) : now) - Date.parse(t.started_at)) || 0;
    events.push({ kind: 'turn', id: t.id, at: t.started_at, endedAt: t.ended_at, seat: t.seat, agent: t.agent, result: t.result, error: t.error, ms, hasLog: Boolean(t.log_file) });
    totals.turns++;
    totals.agentMs += ms;
    totals.bySeat[t.seat] = (totals.bySeat[t.seat] ?? 0) + ms;
  }
  totals.fixRounds = store.getTicketState(project, ticketId)?.fix_rounds ?? 0;
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { events, totals };
}

/** ~maxLines dòng cuối log của một lượt. Đường dẫn chỉ lấy từ DB và phải nằm trong logDir. */
export function readTurnLog(store: Store, project: string, logDir: string, turnId: number, maxLines = 300): string | null {
  const file = store.turnLogFile(project, turnId);
  if (!file) return null;
  const rel = relative(resolve(logDir), resolve(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return null;
  }
}
