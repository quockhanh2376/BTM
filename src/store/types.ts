// Kiểu dữ liệu của store (tách từ db.ts 2026-11-14). Không đổi hành vi.
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Seat, Tool } from '../config.ts';
import type { EnergyReading, EnergyWindow } from '../energy/quota.ts';
import type { LoginHealth, LoginState } from '../energy/login.ts';
import type { Ticket, TicketState, TicketType, TicketSize } from '../ticket/ticket.ts';
import { goalBranch } from '../ticket/goal.ts';
import { git } from '../git.ts';
import { parse as parseYaml } from 'yaml';

export type TurnResult = 'ok' | 'timeout' | 'error' | 'rejected';
export type BoardState = 'pending' | 'in_dev' | 'awaiting_qc' | 'passed' | 'returned' | 'failed' | 'blocked';
export interface LineNote {
  id: number;
  ticket: string;
  path: string;
  line: number;
  text: string;
  used: boolean;
  created_at: string;
}

export type QuestionState = 'open' | 'answered' | 'used';

// Plan 7: mỗi Worker (agent) có nhiều tài khoản; mỗi tài khoản = 1 user Linux. Khoá tài khoản: agent (default) | agent-slug.
export type AccountLabel = 'none' | 'ide' | 'cli' | 'plugin' | 'other';
export interface AccountRow {
  agent: string;
  slug: string;
  email: string | null;
  label: AccountLabel;
  active: boolean;
  ord: number;
  created_at: string;
  /** Công cụ của tài khoản này; null = công cụ của Worker (tài khoản cũ). */
  tool: Tool | null;
}

export interface QuestionRow {
  id: number;
  project: string;
  ticket: string;
  seat: string;
  agent: string | null;
  text: string;
  answer: string | null;
  /** Ảnh anh Zon kèm câu trả lời: tên file trong .git/btm-answers (Q-<id>.<ext>). */
  image: string | null;
  state: QuestionState;
  created_at: string;
}

export type GoalState = 'open' | 'in_progress' | 'qc_done' | 'audit_passed' | 'approved' | 'merged';

export interface GoalRow {
  n: number;
  title: string;
  state: GoalState;
  branch: string;
  created_at: string;
  updated_at: string;
  reviewed_sha?: string | null;
  /** Thùng rác goal (2026-11-14): có giá trị = goal đã vào thùng rác. */
  archived_at?: string | null;
}

export interface TicketRow {
  project: string;
  id: string;
  goal: string;
  number: number;
  of: number;
  title: string;
  type: TicketType;
  size: TicketSize;
  state: TicketState;
  fix_rounds: number;
  base_sha: string | null;
  updated_at: string;
}

export interface TicketTurnRow {
  id: number;
  seat: string;
  agent: string;
  started_at: string;
  ended_at: string | null;
  result: string | null;
  error: string | null;
  log_file: string | null;
}

export interface TicketHistoryRow {
  id: number;
  project: string;
  ticket_id: string;
  from_state: TicketState;
  to_state: TicketState;
  by: string;
  reason: string;
  at: string;
}

export interface QueueItem {
  id: number;
  to: Seat;
  text: string;
  status: 'queued' | 'running' | 'done' | 'cancelled';
  created_at: string;
}

export interface SessionRow {
  id: number;
  status: string;
  project?: string | null;
}

export interface NoteRow {
  id: number;
  project: string;
  text: string;
  image: string | null;
  status: string;
  created_at: string;
  session_id: number | null;
}

export interface Store {
  setActiveProject(path: string): void;
  getActiveProject(): string | null;
  createSession(goals: string[], project?: string | null): number;
  setSessionStatus(id: number, status: string): void;
  getLatestSession(status?: string, project?: string): SessionRow | null;
  getSession(id: number): {
    id: number;
    goals: string[];
    status: string;
    project: string | null;
    started_at: string;
    ended_at: string | null;
  } | null;
  startTurn(sessionId: number, seat: Seat, agent: string, taskId: string | null): number;
  endTurn(turnId: number, result: TurnResult, error?: string): void;
  countTurns(sessionId: number, seat?: Seat): number;
  recordHandoffFailure(sessionId: number, taskId: string, reason: string): void;

  // Plan 2:
  setTurnLog(turnId: number, file: string): void;
  setTaskState(sessionId: number, taskId: string, state: BoardState, fixRounds: number, baseSha?: string | null): void;
  listTaskStates(sessionId: number): { task_id: string; state: BoardState; fix_rounds: number; base_sha?: string | null; updated_at: string }[];
  listTurns(sessionId: number): {
    id: number;
    seat: Seat;
    agent: string;
    task_id: string | null;
    started_at: string;
    ended_at: string | null;
    result: string | null;
    error: string | null;
    log_file: string | null;
  }[];
  listHandoffFailures(sessionId: number): { task_id: string; reason: string; at: string }[];
  enqueue(to: Seat, text: string): number;
  nextQueued(): QueueItem | null;
  /** Câu hỏi chỉ đọc đầu tiên đang chờ (to = "ask-<ghế>"). */
  nextQueuedAsk(): QueueItem | null;
  /** Agent đang có lượt chưa kết thúc (để làn hỏi không dùng chung worker với lượt đang chạy). */
  openTurnAgents(): string[];
  setQueueStatus(id: number, s: QueueItem['status']): void;
  cancelQueued(): number;
  listQueue(limit: number): QueueItem[];
  /** Xoá hẳn các dòng hàng đợi đã xong / đã huỷ tạo trước `before` (dọn Meeting room, 2026-11-14). Trả số dòng đã xoá. */
  purgeQueueBefore(before: string): number;

  /** Đổi đường dẫn project ở mọi bảng + key setting `…:<path>` (btm isolate). */
  renameProject(oldPath: string, newPath: string): void;
  getSetting(key: string): string | null;
  /** Plan 7: tài khoản của Worker (theo máy, không theo project). */
  ensureDefaultAccounts(agents: string[]): void;
  listAccounts(agent?: string): AccountRow[];
  getAccount(agent: string, slug: string): AccountRow | null;
  addAccount(agent: string, slug: string, opts: { email?: string | null; label?: AccountLabel; active: boolean; tool?: Tool | null }): AccountRow;
  updateAccount(agent: string, slug: string, patch: Partial<Pick<AccountRow, 'email' | 'label' | 'active'>>): void;
  moveAccount(agent: string, slug: string, dir: 'up' | 'down'): void;
  /** Xoá dòng tài khoản (dùng khi chuyển tài khoản sang thẻ khác). */
  deleteAccount(agent: string, slug: string): void;
  /** Plan 6 Task 3: ghi chú dòng của anh trên diff ticket. */
  addLineNote(project: string, ticket: string, path: string, line: number, text: string): number;
  listLineNotes(project: string, ticket: string, onlyUnused?: boolean): LineNote[];
  markLineNotesUsed(project: string, ticket: string): void;
  /** Plan 6 Task 4: câu hỏi chặn ticket. state: open → answered → used. */
  addQuestion(project: string, ticket: string, seat: string, agent: string | null, text: string): number;
  listQuestions(project: string, state?: QuestionState): QuestionRow[];
  getQuestion(id: number): QuestionRow | null;
  answerQuestion(id: number, answer: string, image?: string | null): void;
  markQuestionsUsed(project: string, ticket: string): void;
  setSetting(key: string, value: string): void;
  setSessionTasks(sessionId: number, taskIds: string[]): void;
  getSessionTasks(sessionId: number): string[];

  createNote(project: string, text: string, image?: string | null): number;
  getNote(id: number): NoteRow | null;
  setNoteSession(id: number, sessionId: number): void;
  setNoteStatus(id: number, status: string): void;
  setNoteImage(id: number, image: string): void;
  listNotes(project?: string, limit?: number): NoteRow[];
  getNotesBySession(sessionId: number): NoteRow[];
  deleteNote(id: number): void;

  saveEnergy(r: EnergyReading): void;
  latestEnergy(agent: string): EnergyReading | null;
  saveLogin(h: LoginHealth): void;
  latestLogin(agent: string): LoginHealth | null;

  // Plan 4 Task 2:
  createGoal(project: string, title: string): { n: number; branch: string };
  getGoal(project: string, n: number): GoalRow | null;
  listGoals(project: string): GoalRow[];
  /** Thùng rác goal: ẩn goal, kết thúc mọi phiên đang dừng của nó, đóng câu hỏi mở. Không đụng ticket/git. */
  archiveGoal(project: string, n: number): void;
  restoreGoal(project: string, n: number): void;
  listArchivedGoals(project: string): GoalRow[];
  /** Xoá hẳn mọi dòng DB của goal (goal, ticket, lịch sử, câu hỏi, ghi chú dòng, phiên chỉ của goal này + lượt). */
  purgeGoal(project: string, n: number): void;
  /** Dữ liệu goal để sao lưu trước khi xoá hẳn. */
  exportGoal(project: string, n: number): Record<string, unknown>;
  /** Phiên của các goal (theo số n) – để bỏ qua phiên của goal đã vào thùng rác. */
  sessionGoalNumbers(sessionId: number): number[];
  /** Thời gian goal (anh Zon 2026-11-14): các lượt thuộc phiên chỉ của goal này. */
  goalTurns(project: string, n: number): Array<{ seat: string; agent: string; started_at: string; ended_at: string | null }>;
  setGoalState(project: string, n: number, state: GoalState, by: string, reason?: string, reviewedSha?: string | null): void;
  upsertTicket(project: string, t: Ticket): void;
  getTicketState(project: string, id: string): { state: TicketState; fix_rounds: number; base_sha: string | null } | null;
  setTicketState(project: string, id: string, to: TicketState, by: string, reason: string, fixRounds?: number, baseSha?: string | null): void;
  listTickets(project: string, goal?: string): TicketRow[];
  ticketHistory(project: string, id: string): TicketHistoryRow[];
  /** Truy vết ticket (anh Zon 2026-11-14): mọi lượt có task_id = ticket, thuộc phiên của project. */
  ticketTurns(project: string, ticketId: string): TicketTurnRow[];
  /** File log của một lượt thuộc project (null nếu không có / project khác). */
  turnLogFile(project: string, turnId: number): string | null;
  nextTicketSeq(project: string): number;
  bumpTicketSeq(project: string, usedMax: number): void;

  close(): void;
}

