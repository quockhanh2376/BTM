// Route nhóm "tickets" tách khỏi http.ts 2026-11-14 (docs/engineering-rules.md). Không đổi hành vi.
// handle*(…) trả true khi đã trả lời request.
import type { ServerResponse } from 'node:http';
import type { ServerOpts, SendJson } from '../http.ts';
import { z } from 'zod';
import { ticketDiff } from '../diff.ts';
import { retryTicket } from '../ticket-retry.ts';

export async function handleTicketsGet(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Ticket history route
  const ticketHistoryMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/history$/);
  if (method === 'GET' && ticketHistoryMatch) {
    const ticketId = ticketHistoryMatch[1];
    const activeProject = o.store.getActiveProject();
    if (!activeProject) {
      sendJson(res, 404, { error: 'No active project' });
      return true;
    }
    const history = o.store.ticketHistory(activeProject, ticketId);
    sendJson(res, 200, history);
    return true;
  }

  // Plan 6 Task 3: diff ticket + ghi chú dòng
  const ticketDiffMatch = pathname.match(/^\/api\/tickets\/([A-Z][A-Z0-9]*-\d{1,8})\/(diff|notes)$/);
  if (method === 'GET' && ticketDiffMatch) {
    const activeProject = o.store.getActiveProject();
    if (!activeProject) {
      sendJson(res, 404, { error: 'No active project' });
      return true;
    }
    const ticketId = ticketDiffMatch[1]!;
    if (ticketDiffMatch[2] === 'notes') {
      sendJson(res, 200, o.store.listLineNotes(activeProject, ticketId));
      return true;
    }
    const row = o.store.listTickets(activeProject).find((t) => t.id === ticketId);
    const goal = row ? o.store.getGoal(activeProject, parseInt(row.goal.replace(/^G/, ''), 10)) : null;
    if (!row || !goal) {
      sendJson(res, 404, { error: 'Unknown ticket' });
      return true;
    }
    if (!row.base_sha) {
      sendJson(res, 400, { error: 'Ticket has no base yet' });
      return true;
    }
    try {
      sendJson(res, 200, ticketDiff(activeProject, row.base_sha, goal.branch, ticketId));
    } catch {
      sendJson(res, 500, { error: 'Diff failed' });
    }
    return true;
  }
  return false;
}

export async function handleTicketsPost(method: string | undefined, pathname: string, body: unknown, o: ServerOpts, res: ServerResponse, sendJson: SendJson): Promise<boolean> {
  // Nút "Làm lại ticket": failed/blocked → returned (đủ vòng sửa mới), gỡ ticket bị chặn dây chuyền.
  const retryMatch = pathname.match(/^\/api\/tickets\/([A-Z][A-Z0-9]*-\d{1,8})\/retry$/);
  if (retryMatch) {
    if (o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    const project = o.store.getActiveProject();
    if (!project) {
      sendJson(res, 400, { error: 'No active project' });
      return true;
    }
    const result = retryTicket(o.store, project, retryMatch[1]!);
    sendJson(res, result.ok ? 200 : result.status, result);
    return true;
  }

  // Plan 6 Task 3: ghi chú dòng + trả ticket về Dev
  const ticketPostMatch = pathname.match(/^\/api\/tickets\/([A-Z][A-Z0-9]*-\d{1,8})\/(notes|return)$/);
  if (ticketPostMatch) {
    if (ticketPostMatch[2] === 'return' && o.host.busy?.()) {
      sendJson(res, 409, { error: 'Session running' });
      return true;
    }
    const activeProject = o.store.getActiveProject();
    if (!activeProject) {
      sendJson(res, 400, { error: 'No active project' });
      return true;
    }
    const ticketId = ticketPostMatch[1]!;
    const row = o.store.listTickets(activeProject).find((t) => t.id === ticketId);
    const goalN = row ? parseInt(row.goal.replace(/^G/, ''), 10) : NaN;
    const goal = row ? o.store.getGoal(activeProject, goalN) : null;
    if (!row || !goal) {
      sendJson(res, 404, { error: 'Unknown ticket' });
      return true;
    }
    if (ticketPostMatch[2] === 'notes') {
      const parsed = z.object({
        path: z.string().min(1).max(500),
        line: z.number().int().min(1).max(10_000_000),
        text: z.string().trim().min(1).max(1000),
      }).strict().safeParse(body);
      if (!parsed.success) {
        sendJson(res, 400, { error: 'Invalid note' });
        return true;
      }
      const id = o.store.addLineNote(activeProject, ticketId, parsed.data.path, parsed.data.line, parsed.data.text);
      sendJson(res, 200, { ok: true, id });
      return true;
    }
    if (goal.state === 'approved' || goal.state === 'merged') {
      sendJson(res, 409, { error: 'Goal already merged' });
      return true;
    }
    if (!['passed', 'returned', 'failed'].includes(row.state)) {
      sendJson(res, 409, { error: `Ticket is ${row.state}` });
      return true;
    }
    const waiting = o.store.getLatestSession('needs_owner', activeProject) ?? o.store.getLatestSession('awaiting_approval', activeProject);
    if (waiting) {
      sendJson(res, 409, { error: 'Another session is waiting – resume or finish it first' });
      return true;
    }
    if (o.store.listLineNotes(activeProject, ticketId, true).length === 0) {
      sendJson(res, 400, { error: 'Add a note first' });
      return true;
    }
    // Anh trả về: cấp lại đủ vòng sửa.
    o.store.setTicketState(activeProject, ticketId, 'returned', 'owner', 'owner_line_notes', 0, row.base_sha);
    o.store.setGoalState(activeProject, goalN, 'in_progress', 'owner', `ticket ${ticketId} returned`);
    // Phiên mới cho goal ở needs_owner: anh bấm Resume là Dev làm lại với ghi chú.
    const sid = o.store.createSession([String(goalN)], activeProject);
    o.store.setSessionStatus(sid, 'needs_owner');
    sendJson(res, 200, { ok: true, sessionId: sid });
    return true;
  }
  return false;
}
