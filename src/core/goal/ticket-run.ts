// Trạng thái một ticket trong vòng Dev → gate → QC, dùng chung cho dev-turn và qc-turn (tách 2026-11-14).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkReady, type Ticket, type TicketState } from '../../ticket/ticket.ts';
import { inboxPath } from '../../server/inbox.ts';
import type { GuardTurnResult } from '../guard.ts';
import type { SessionOutcome } from '../session.ts';
import type { GoalCtx } from './ctx.ts';

export interface TicketRun {
  ticket: Ticket;
  /** Sha gốc của ticket (QC xem base..HEAD); null tới lượt Dev đầu tiên. */
  base: string | null;
  fixNotes: string[];
  fixRounds: number;
  /** Agent đã code ticket này (luật coder_cannot_qc_same_task). */
  coders: Set<string>;
  images: string[] | undefined;
}

/** Dựng trạng thái ban đầu của ticket từ DB, báo cáo QC cũ, ghi chú và câu trả lời của anh. */
export function openTicketRun(
  ctx: GoalCtx,
  ticket: Ticket,
  stored: { fix_rounds: number; base_sha: string | null } | null,
  initialTaskState: TicketState,
): TicketRun {
  const { d, sessionId, ownerAnswers, answerImages } = ctx;
  const base = stored?.base_sha || null;
  let fixNotes: string[] = [];
  const fixRounds = stored?.fix_rounds ?? 0;

  if (initialTaskState === 'returned') {
    const reportsDir = join(d.repo, 'team', 'reports');
    const qcReportPath = join(reportsDir, `${ticket.id}-qc.json`);
    if (existsSync(qcReportPath)) {
      try {
        const qcData = JSON.parse(readFileSync(qcReportPath, 'utf8'));
        if (Array.isArray(qcData.bugs) || Array.isArray(qcData.fix)) {
          fixNotes = [...(qcData.bugs || []), ...(qcData.fix || [])];
        }
      } catch {}
    }
    if (fixNotes.length === 0) {
      const failures = d.store.listHandoffFailures(sessionId).filter((f) => f.task_id === ticket.id);
      if (failures.length > 0) {
        fixNotes = failures.map((f) => f.reason);
      }
    }
  }

  // Plan 6 Task 3+4: ghi chú dòng và câu trả lời của anh đi trước ghi chú QC.
  const ownerNotes = [
    ...d.store.listLineNotes(d.repo, ticket.id, true).map((n) => `Anh Zon (${n.path}:${n.line}): ${n.text}`),
    ...ownerAnswers(ticket.id),
  ];
  if (ownerNotes.length > 0) fixNotes = [...ownerNotes, ...fixNotes];

  const coders = new Set<string>();
  for (const t of d.store.listTurns(sessionId)) {
    if (t.seat === 'dev' && t.task_id === ticket.id && t.agent) {
      coders.add(t.agent);
    }
  }
  try {
    const hist = d.store.ticketHistory(d.repo, ticket.id);
    for (const h of hist) {
      if ((h.to_state === 'in_dev' || h.to_state === 'awaiting_qc') && h.by) {
        coders.add(h.by);
      }
    }
  } catch {}

  let images: string[] | undefined;
  if (ticket.note) {
    const rawId = ticket.note.replace(/^N-/, '');
    const noteIdNum = Number(rawId);
    if (!isNaN(noteIdNum)) {
      const note = d.store.getNote(noteIdNum);
      if (note?.image) {
        try {
          const imgPath = inboxPath(d.repo, note.image);
          if (existsSync(imgPath)) {
            images = [imgPath];
          }
        } catch {}
      }
    }
  }

  const qImages = answerImages(ticket.id);
  if (qImages.length > 0) images = [...(images ?? []), ...qImages];

  return { ticket, base, fixNotes, fixRounds, coders, images };
}

/** Vượt số vòng sửa: ticket failed, ticket còn chờ mà chưa sẵn sàng thì blocked, goal dừng chờ anh. */
export function failMaxFixRounds(ctx: GoalCtx, run: TicketRun, goalTickets: Ticket[], by: string, detail: string): SessionOutcome {
  const { d, sessionId, tasks } = ctx;
  tasks[run.ticket.id] = 'failed';
  d.store.setTicketState(d.repo, run.ticket.id, 'failed', by, 'max fix rounds exceeded', run.fixRounds, run.base);
  for (const rem of goalTickets) {
    if (!tasks[rem.id] || tasks[rem.id] === 'pending') {
      const remReady = checkReady(rem, (id) => d.store.getTicketState(d.repo, id)?.state ?? null);
      if (remReady.length > 0) {
        const reason = `not_ready: ${remReady.join(', ')}`;
        d.store.setTicketState(d.repo, rem.id, 'blocked', 'core', reason);
        tasks[rem.id] = 'blocked';
      }
    }
  }
  return {
    status: 'needs_owner',
    sessionId,
    tasks,
    notes: [`Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: ${detail}`],
  };
}

/** Lượt lỗi/timeout/huỷ: vi phạm guard (theo thứ tự ưu tiên) che lý do lỗi gốc. */
export function erroredGuardNote(guard: GuardTurnResult): string | null {
  if (guard.gitConfigTampered) return 'git_config_tampered';
  if (guard.modifiedProtectedBranch) return 'agent_modified_protected_branch';
  if (guard.protectedBranchMoved) return 'protected_branch_moved';
  if (guard.modifiedOtherGoal) return 'agent_modified_other_goal';
  return null;
}
