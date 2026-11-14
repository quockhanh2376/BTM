import type { Store } from '../store/db.ts';

// Nút "Làm lại ticket" (anh Zon 2026-11-14): ticket failed/blocked → returned với đủ vòng sửa mới; các ticket
// cùng goal bị core chặn dây chuyền (blocked bởi 'core') → pending. Có sẵn phiên để anh bấm Resume.
// Thay cho việc Cheki sửa DB bằng tay (GT-0005/GT-0006, 2026-11-14).

export type RetryResult = { ok: true; reopened: string[]; sessionId: number } | { ok: false; status: number; error: string };

const RESUMABLE = new Set(['needs_owner', 'stopped', 'out_of_turns']);

export function retryTicket(store: Store, project: string, id: string): RetryResult {
  const row = store.listTickets(project).find((t) => t.id === id);
  if (!row) return { ok: false, status: 404, error: 'Unknown ticket' };
  if (row.state !== 'failed' && row.state !== 'blocked') return { ok: false, status: 409, error: `Ticket is ${row.state}` };
  const n = parseInt(row.goal.replace(/^G/i, ''), 10);
  const goal = store.getGoal(project, n);
  if (!goal) return { ok: false, status: 404, error: 'Unknown goal' };
  if (goal.archived_at) return { ok: false, status: 409, error: 'Goal is in Trash' };
  if (goal.state === 'approved' || goal.state === 'merged') return { ok: false, status: 409, error: 'Goal already merged' };

  store.setTicketState(project, id, 'returned', 'owner', 'owner_retry', 0, row.base_sha);
  const reopened = [id];
  for (const t of store.listTickets(project, row.goal)) {
    if (t.id === id || t.state !== 'blocked') continue;
    const last = store.ticketHistory(project, t.id).at(-1);
    if (last?.by === 'core') {
      store.setTicketState(project, t.id, 'pending', 'owner', `owner_retry: unblocked with ${id}`, t.fix_rounds, t.base_sha);
      reopened.push(t.id);
    }
  }
  if (goal.state !== 'in_progress') store.setGoalState(project, n, 'in_progress', 'owner', `ticket ${id} retried`);

  // Phiên để Resume: dùng phiên dừng mới nhất của goal nếu có (hết lượt thì Resume tự mở phiên mới), không thì tạo.
  const latest = store.getLatestSession(undefined, project);
  const goalsOf = latest ? store.sessionGoalNumbers(latest.id) : [];
  if (latest && RESUMABLE.has(latest.status) && goalsOf.length > 0 && goalsOf.every((x) => x === n)) {
    return { ok: true, reopened, sessionId: latest.id };
  }
  const sessionId = store.createSession([String(n)], project);
  store.setSessionStatus(sessionId, 'needs_owner');
  return { ok: true, reopened, sessionId };
}
