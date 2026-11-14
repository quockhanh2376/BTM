// GoalCtx: trạng thái chung của một goal trong phiên, truyền cho từng lượt (tách 2026-11-14).
import type { Seat } from '../../config.ts';
import { type TicketState } from '../../ticket/ticket.ts';
import type { SessionDeps } from '../session.ts';

export interface GoalCtx {
  d: SessionDeps;
  sessionId: number;
  goal: { n: number; title: string; branch: string };
  key: string;
  tasks: Record<string, TicketState>;
  attachedNote: ReturnType<SessionDeps['store']['getNote']>;
  baseBranch: string;
  /** Agent ngồi ghế PM (đổi khi người chính hết Energy → dự phòng). */
  pmAgent: string;
  pmAuthor: { name: string; email: string };
  ownerAnswers(ticketId: string): string[];
  answerImages(ticketId: string): string[];
  askQuestions(ticketId: string, seat: Seat, agent: string, items: string[]): number;
  backupsFor(seat: Seat): string[];
  pickSeatAgent(seat: Seat, primary: string, exclude?: Set<string>): Promise<{ agent: string } | { agent: null; notes: string[] }>;
}

