// Vòng ticket Dev → gate → QC (tách khỏi processGoal 2026-11-14, không đổi hành vi).
import { effectiveSeats } from '../../store/db.ts';
import { checkReady, type Ticket } from '../../ticket/ticket.ts';
import { headSha } from '../../git.ts';
import type { SessionOutcome } from '../session.ts';
import type { GoalCtx } from './ctx.ts';
import { openTicketRun } from './ticket-run.ts';
import { runDevTurn } from './dev-turn.ts';
import { runQcTurn } from './qc-turn.ts';

/** Vòng ticket: Dev → gate → QC cho từng ticket theo thứ tự. null = mọi ticket đã xử lý xong vòng này. */
export async function runTickets(ctx: GoalCtx, goalTickets: Ticket[]): Promise<SessionOutcome | null> {
  const { d, sessionId, tasks } = ctx;
  for (const ticket of goalTickets) {
    if (d.signal?.aborted) {
      return {
        status: 'stopped',
        sessionId,
        tasks,
        notes: ['Session aborted'],
      };
    }
    const stored = d.store.getTicketState(d.repo, ticket.id);
    const initialTaskState = stored?.state ?? tasks[ticket.id] ?? 'pending';

    if (initialTaskState === 'passed' || initialTaskState === 'cancelled') {
      tasks[ticket.id] = initialTaskState;
      continue;
    }

    // Plan 6 Task 4: ticket còn câu hỏi chưa trả lời → dừng goal chờ anh (không chạy ticket khác để commit các
    // ticket không xen nhau trong base..HEAD).
    {
      const openQ = d.store.listQuestions(d.repo, 'open').filter((q) => q.ticket === ticket.id).length;
      if (openQ > 0) {
        tasks[ticket.id] = stored?.state ?? 'returned';
        return { status: 'needs_owner', sessionId, tasks, notes: [`questions_open:${openQ}`, `Ticket ${ticket.id} waits for your answers`] };
      }
    }

    // Check Definition of Ready
    const readyErrors = checkReady(ticket, (id) => d.store.getTicketState(d.repo, id)?.state ?? null);
    if (readyErrors.length > 0) {
      const reason = `not_ready: ${readyErrors.join(', ')}`;
      d.store.setTicketState(d.repo, ticket.id, 'blocked', 'core', reason);
      tasks[ticket.id] = 'blocked';
      return {
        status: 'needs_owner',
        sessionId,
        tasks,
        notes: [`Ticket ${ticket.id} is blocked: ${reason}`],
      };
    }

    const run = openTicketRun(ctx, ticket, stored, initialTaskState);
    let skipDevThisRound = (initialTaskState === 'awaiting_qc');

    while (true) {
      if (d.signal?.aborted) {
        return {
          status: 'stopped',
          sessionId,
          tasks,
          notes: ['Session aborted'],
        };
      }
      const seats = effectiveSeats(d.cfg, d.store, d.repo);
      let devAgent = Object.hasOwn(seats, 'dev') ? seats.dev : d.cfg.seats.dev;
      // base chỉ rỗng khi DB chưa có base_sha → lấy HEAD lúc Dev (hoặc QC khi bỏ qua Dev) bắt đầu.
      const base = (run.base ||= headSha(d.repo));

      if (!skipDevThisRound) {
        const dev = await runDevTurn(ctx, run, goalTickets, base, devAgent);
        if (dev === 'again') continue;
        if ('status' in dev) return dev;
        devAgent = dev.readyBy;
      } else {
        skipDevThisRound = false;
      }

      d.store.setTicketState(d.repo, ticket.id, 'awaiting_qc', devAgent, 'ready for qc', run.fixRounds, base);
      tasks[ticket.id] = 'awaiting_qc';

      const qc = await runQcTurn(ctx, run, goalTickets, base, Object.hasOwn(seats, 'qc') ? seats.qc : d.cfg.seats.qc);
      if (qc === 'passed') break;
      if (qc !== 'returned') return qc;
    }
  }

  return null;
}
