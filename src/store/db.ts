import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Seat } from '../config.ts';
import type { EnergyReading, EnergyWindow } from '../energy/quota.ts';
import type { LoginHealth, LoginState } from '../energy/login.ts';
import type { Ticket, TicketState, TicketType, TicketSize } from '../ticket/ticket.ts';
import { goalBranch } from '../ticket/goal.ts';
import { git } from '../git.ts';
import { parse as parseYaml } from 'yaml';

// Kiểu dữ liệu, chọn ghế, schema: tách 2026-11-14 (docs/engineering-rules.md); db.ts re-export để import cũ vẫn chạy.
export * from './types.ts';
export * from './seats.ts';
import type { AccountLabel, AccountRow, Store, BoardState, GoalRow, GoalState, LineNote, NoteRow, QuestionRow, QuestionState, QueueItem, SessionRow, TicketHistoryRow, TicketRow, TicketTurnRow, TurnResult } from './types.ts';
import { migrate } from './schema.ts';

function toAccount(r: any): AccountRow {
  return {
    agent: String(r.agent),
    slug: String(r.slug),
    email: r.email === null || r.email === undefined ? null : String(r.email),
    label: String(r.label) as AccountLabel,
    active: Number(r.active) === 1,
    ord: Number(r.ord),
    created_at: String(r.created_at),
  };
}

const openStores = new Set<Store>();

export function getOpenStores(): ReadonlySet<Store> {
  return openStores;
}

export function openStore(file: string): Store {
  if (file !== ':memory:') {
    const dir = dirname(file);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(file);

  if (file !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  migrate(db);

  const setActiveProjectStmt = db.prepare(`
    INSERT INTO active_project (id, path) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path
  `);

  const getActiveProjectStmt = db.prepare(`
    SELECT path FROM active_project WHERE id = 1
  `);

  const createSessionStmt = db.prepare(`
    INSERT INTO sessions (project, goals_json, status, started_at, ended_at)
    VALUES (?, ?, 'running', ?, NULL)
  `);

  const updateSessionStatusTerminalStmt = db.prepare(`
    UPDATE sessions SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?
  `);

  const updateSessionStatusStmt = db.prepare(`
    UPDATE sessions SET status = ? WHERE id = ?
  `);

  const getLatestSessionStmt = db.prepare(`
    SELECT id, status, project FROM sessions ORDER BY id DESC LIMIT 1
  `);

  const getLatestSessionWithStatusStmt = db.prepare(`
    SELECT id, status, project FROM sessions WHERE status = ? ORDER BY id DESC LIMIT 1
  `);

  const getLatestSessionWithProjectStmt = db.prepare(`
    SELECT id, status, project FROM sessions WHERE project = ? ORDER BY id DESC LIMIT 1
  `);

  const getLatestSessionWithStatusAndProjectStmt = db.prepare(`
    SELECT id, status, project FROM sessions WHERE status = ? AND project = ? ORDER BY id DESC LIMIT 1
  `);

  const getSessionStmt = db.prepare(`
    SELECT id, goals_json, status, project, started_at, ended_at FROM sessions WHERE id = ?
  `);

  const startTurnStmt = db.prepare(`
    INSERT INTO turns (session_id, seat, agent, task_id, started_at, ended_at, result, error, log_file)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
  `);

  const endTurnStmt = db.prepare(`
    UPDATE turns SET ended_at = ?, result = ?, error = ? WHERE id = ?
  `);

  // Lượt tính vào hạn mức: bỏ lượt hỏng vì hết quota/không có tài khoản/bị Stop (không làm gì), và lượt trước
  // lần Resume phiên hết lượt (settings turns_from:<session> = lúc Resume).
  const countedTurns = `session_id = ?
      AND started_at >= COALESCE((SELECT value FROM settings WHERE key = 'turns_from:' || session_id), '')
      AND (error IS NULL OR (error <> 'aborted' AND error NOT LIKE 'usage_limit_hit:%' AND error NOT LIKE 'no_usable_account:%'))`;
  const countAllTurnsStmt = db.prepare(`
    SELECT COUNT(*) as count FROM turns WHERE ${countedTurns}
  `);

  const countSeatTurnsStmt = db.prepare(`
    SELECT COUNT(*) as count FROM turns WHERE ${countedTurns} AND seat = ?
  `);

  const recordHandoffFailureStmt = db.prepare(`
    INSERT INTO handoff_failures (session_id, task_id, reason, at)
    VALUES (?, ?, ?, ?)
  `);

  const setTurnLogStmt = db.prepare(`
    UPDATE turns SET log_file = ? WHERE id = ?
  `);

  const setTaskStateStmt = db.prepare(`
    INSERT INTO task_states (session_id, task_id, state, fix_rounds, base_sha, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, task_id) DO UPDATE SET
      state = excluded.state,
      fix_rounds = excluded.fix_rounds,
      base_sha = COALESCE(task_states.base_sha, excluded.base_sha),
      updated_at = excluded.updated_at
  `);

  const listTaskStatesStmt = db.prepare(`
    SELECT task_id, state, fix_rounds, base_sha, updated_at
    FROM task_states
    WHERE session_id = ?
    ORDER BY rowid ASC
  `);

  const listTurnsStmt = db.prepare(`
    SELECT id, seat, agent, task_id, started_at, ended_at, result, error, log_file
    FROM turns
    WHERE session_id = ?
    ORDER BY id ASC
  `);

  const listHandoffFailuresStmt = db.prepare(`
    SELECT task_id, reason, at
    FROM handoff_failures
    WHERE session_id = ?
    ORDER BY id ASC
  `);

  const enqueueStmt = db.prepare(`
    INSERT INTO queue ("to", text, status, created_at)
    VALUES (?, ?, 'queued', ?)
  `);

  // Câu hỏi "ask-<ghế>" chạy ở làn riêng (ask-lane), làn lệnh thường bỏ qua chúng.
  const nextQueuedStmt = db.prepare(`
    SELECT id, "to", text, status, created_at
    FROM queue
    WHERE status = 'queued' AND "to" NOT LIKE 'ask-%'
    ORDER BY id ASC
    LIMIT 1
  `);

  const setQueueStatusStmt = db.prepare(`
    UPDATE queue SET status = ? WHERE id = ?
  `);

  const cancelQueuedStmt = db.prepare(`
    UPDATE queue SET status = 'cancelled' WHERE status = 'queued'
  `);

  const listQueueStmt = db.prepare(`
    SELECT id, "to", text, status, created_at
    FROM queue
    ORDER BY id DESC
    LIMIT ?
  `);

  const getSettingStmt = db.prepare(`
    SELECT value FROM settings WHERE key = ?
  `);

  const setSettingStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const setSessionTaskStmt = db.prepare(`
    INSERT OR IGNORE INTO session_tasks (session_id, task_id) VALUES (?, ?)
  `);

  const getSessionTasksStmt = db.prepare(`
    SELECT task_id FROM session_tasks WHERE session_id = ? ORDER BY rowid ASC
  `);

  const createNoteStmt = db.prepare(`
    INSERT INTO notes (project, text, image, status, created_at, session_id)
    VALUES (?, ?, ?, 'open', ?, NULL)
  `);

  const getNoteStmt = db.prepare(`
    SELECT id, project, text, image, status, created_at, session_id
    FROM notes
    WHERE id = ?
  `);

  const setNoteSessionStmt = db.prepare(`
    UPDATE notes SET session_id = ? WHERE id = ?
  `);

  const setNoteStatusStmt = db.prepare(`
    UPDATE notes SET status = ? WHERE id = ?
  `);

  const setNoteImageStmt = db.prepare(`
    UPDATE notes SET image = ? WHERE id = ?
  `);

  const listNotesByProjectStmt = db.prepare(`
    SELECT id, project, text, image, status, created_at, session_id
    FROM notes
    WHERE project = ?
    ORDER BY id DESC
    LIMIT ?
  `);

  const listAllNotesStmt = db.prepare(`
    SELECT id, project, text, image, status, created_at, session_id
    FROM notes
    ORDER BY id DESC
    LIMIT ?
  `);

  const deleteNoteStmt = db.prepare(`
    DELETE FROM notes WHERE id = ?
  `);

  const getNotesBySessionStmt = db.prepare(`
    SELECT id, project, text, image, status, created_at, session_id
    FROM notes
    WHERE session_id = ?
    ORDER BY id ASC
  `);

  const saveEnergyStmt = db.prepare(`
    INSERT INTO energy_readings (agent, status, windows_json, read_at, note)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getLatestEnergyStmt = db.prepare(`
    SELECT agent, status, windows_json, read_at, note
    FROM energy_readings
    WHERE agent = ?
    ORDER BY id DESC
    LIMIT 1
  `);

  const saveLoginStmt = db.prepare(`
    INSERT INTO login_health (agent, state, detail, expires_at, checked_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getLatestLoginStmt = db.prepare(`
    SELECT agent, state, detail, expires_at
    FROM login_health
    WHERE agent = ?
    ORDER BY id DESC
    LIMIT 1
  `);

  const getMaxGoalNStmt = db.prepare(`
    SELECT COALESCE(MAX(n), 0) AS max_n FROM goals WHERE project = ?
  `);

  const insertGoalStmt = db.prepare(`
    INSERT INTO goals (project, n, title, state, branch, created_at, updated_at)
    VALUES (?, ?, ?, 'open', ?, ?, ?)
  `);

  const getGoalStmt = db.prepare(`
    SELECT n, title, state, branch, created_at, updated_at, reviewed_sha, archived_at
    FROM goals
    WHERE project = ? AND n = ?
  `);

  const listGoalsStmt = db.prepare(`
    SELECT n, title, state, branch, created_at, updated_at, reviewed_sha, archived_at
    FROM goals
    WHERE project = ?
    ORDER BY n ASC
  `);
  // goals_json lưu cả dạng ["1"] lẫn [2] → so theo số.
  const goalNumsOf = (json: string): number[] => {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.map((x) => parseInt(String(x).replace(/^G/i, ''), 10)).filter((x) => Number.isFinite(x)) : [];
    } catch {
      return [];
    }
  };
  const sessionsOfGoal = (project: string, n: number): number[] =>
    (db.prepare('SELECT id, goals_json FROM sessions WHERE project = ?').all(project) as Array<{ id: number; goals_json: string }>)
      .filter((r) => { const g = goalNumsOf(r.goals_json); return g.length > 0 && g.every((x) => x === n); })
      .map((r) => r.id);
  const ticketIdsOfGoal = (project: string, n: number): string[] =>
    (db.prepare('SELECT id FROM tickets WHERE project = ? AND goal = ?').all(project, `G${n}`) as Array<{ id: string }>).map((r) => r.id);

  const updateGoalStateStmt = db.prepare(`
    UPDATE goals SET state = ?, updated_at = ? WHERE project = ? AND n = ?
  `);

  const updateGoalStateWithShaStmt = db.prepare(`
    UPDATE goals SET state = ?, updated_at = ?, reviewed_sha = ? WHERE project = ? AND n = ?
  `);

  const upsertTicketStmt = db.prepare(`
    INSERT INTO tickets (
      project, id, goal, number, of, title, type, size, state, fix_rounds, base_sha, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?
    )
    ON CONFLICT(project, id) DO UPDATE SET
      goal = excluded.goal,
      number = excluded.number,
      of = excluded.of,
      title = excluded.title,
      type = excluded.type,
      size = excluded.size,
      updated_at = excluded.updated_at
  `);

  const getTicketStateStmt = db.prepare(`
    SELECT state, fix_rounds, base_sha
    FROM tickets
    WHERE project = ? AND id = ?
  `);

  const getTicketRowStmt = db.prepare(`
    SELECT project, id, goal, number, of, title, type, size, state, fix_rounds, base_sha, updated_at
    FROM tickets
    WHERE project = ? AND id = ?
  `);

  const updateTicketStateStmt = db.prepare(`
    UPDATE tickets
    SET state = ?, fix_rounds = ?, base_sha = ?, updated_at = ?
    WHERE project = ? AND id = ?
  `);

  const insertTicketHistoryStmt = db.prepare(`
    INSERT INTO ticket_history (project, ticket_id, from_state, to_state, by, reason, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const listTicketsAllStmt = db.prepare(`
    SELECT project, id, goal, number, of, title, type, size, state, fix_rounds, base_sha, updated_at
    FROM tickets
    WHERE project = ?
    ORDER BY CAST(SUBSTR(goal, 2) AS INTEGER) ASC, number ASC
  `);

  const listTicketsByGoalStmt = db.prepare(`
    SELECT project, id, goal, number, of, title, type, size, state, fix_rounds, base_sha, updated_at
    FROM tickets
    WHERE project = ? AND goal = ?
    ORDER BY number ASC
  `);

  const ticketHistoryStmt = db.prepare(`
    SELECT id, project, ticket_id, from_state, to_state, by, reason, at
    FROM ticket_history
    WHERE project = ? AND ticket_id = ?
    ORDER BY id ASC
  `);

  const getNextTicketSeqStmt = db.prepare(`
    SELECT next_ticket_seq FROM project_counters WHERE project = ?
  `);

  const bumpTicketSeqStmt = db.prepare(`
    INSERT INTO project_counters (project, next_ticket_seq)
    VALUES (?, ?)
    ON CONFLICT(project) DO UPDATE SET
      next_ticket_seq = MAX(project_counters.next_ticket_seq, excluded.next_ticket_seq)
  `);

  const createGoalTx = db.transaction((project: string, title: string) => {
    const row = getMaxGoalNStmt.get(project) as { max_n: number } | undefined;
    // Số goal = ID duy nhất, không dùng lại kể cả sau khi xoá hẳn (nhánh, ticket, log, bản sao lưu mang số này).
    const floor = db.prepare('SELECT value FROM settings WHERE key = ?').get(`goal_n_floor:${project}`) as { value: string } | undefined;
    const n = Math.max(row?.max_n ?? 0, floor ? parseInt(floor.value, 10) || 0 : 0) + 1;
    const branch = goalBranch(n, title);
    const now = new Date().toISOString();
    insertGoalStmt.run(project, n, title, branch, now, now);
    return { n, branch };
  });

  const setTicketStateTx = db.transaction((
    project: string,
    id: string,
    to: TicketState,
    by: string,
    reason: string,
    fixRounds?: number,
    baseSha?: string | null
  ) => {
    const row = getTicketRowStmt.get(project, id) as {
      state: TicketState;
      fix_rounds: number;
      base_sha: string | null;
    } | undefined;

    if (!row) {
      throw new Error(`Ticket "${id}" not found in project "${project}"`);
    }

    const fromState = row.state;
    const newFixRounds = fixRounds !== undefined ? fixRounds : row.fix_rounds;
    const newBaseSha = baseSha !== undefined ? baseSha : row.base_sha;
    const now = new Date().toISOString();

    updateTicketStateStmt.run(to, newFixRounds, newBaseSha, now, project, id);
    insertTicketHistoryStmt.run(project, id, fromState, to, by, reason, now);
  });

  const renameProject = db.transaction((oldPath: string, newPath: string) => {
    for (const t of ['sessions', 'notes', 'goals', 'tickets', 'ticket_history', 'project_counters', 'line_notes', 'questions']) {
      db.prepare(`UPDATE ${t} SET project = ? WHERE project = ?`).run(newPath, oldPath);
    }
    db.prepare('UPDATE active_project SET path = ? WHERE path = ?').run(newPath, oldPath);
    const suffix = `:${oldPath}`;
    const rows = db.prepare('SELECT key FROM settings').all() as { key: string }[];
    for (const { key } of rows) {
      if (!key.endsWith(suffix)) continue;
      const newKey = key.slice(0, -oldPath.length) + newPath;
      db.prepare('DELETE FROM settings WHERE key = ?').run(newKey);
      db.prepare('UPDATE settings SET key = ? WHERE key = ?').run(newKey, key);
    }
  });

  const storeObj: Store = {
    renameProject(oldPath: string, newPath: string): void {
      renameProject(oldPath, newPath);
    },

    setActiveProject(path: string): void {
      setActiveProjectStmt.run(path);
    },

    getActiveProject(): string | null {
      const row = getActiveProjectStmt.get() as { path: string } | undefined;
      return row ? row.path : null;
    },

    createSession(goals: string[], project?: string | null): number {
      const now = new Date().toISOString();
      const info = createSessionStmt.run(project ?? null, JSON.stringify(goals), now);
      return Number(info.lastInsertRowid);
    },

    setSessionStatus(id: number, status: string): void {
      const isTerminal = status !== 'running' && status !== 'pending';
      if (isTerminal) {
        updateSessionStatusTerminalStmt.run(status, new Date().toISOString(), id);
      } else {
        updateSessionStatusStmt.run(status, id);
      }
    },

    getLatestSession(status?: string, project?: string): SessionRow | null {
      let row: { id: number; status: string; project?: string | null } | undefined;
      if (status !== undefined && project !== undefined) {
        row = getLatestSessionWithStatusAndProjectStmt.get(status, project) as { id: number; status: string; project?: string | null } | undefined;
      } else if (status !== undefined) {
        row = getLatestSessionWithStatusStmt.get(status) as { id: number; status: string; project?: string | null } | undefined;
      } else if (project !== undefined) {
        row = getLatestSessionWithProjectStmt.get(project) as { id: number; status: string; project?: string | null } | undefined;
      } else {
        row = getLatestSessionStmt.get() as { id: number; status: string; project?: string | null } | undefined;
      }
      if (!row) return null;
      const res: SessionRow = { id: Number(row.id), status: String(row.status) };
      if (row.project !== null && row.project !== undefined) {
        res.project = String(row.project);
      }
      return res;
    },

    getSession(id: number): {
      id: number;
      goals: string[];
      status: string;
      project: string | null;
      started_at: string;
      ended_at: string | null;
    } | null {
      const row = getSessionStmt.get(id) as {
        id: number;
        goals_json: string;
        status: string;
        project?: string | null;
        started_at?: string | null;
        ended_at?: string | null;
      } | undefined;
      if (!row) return null;

      let goals: string[] = [];
      if (row.goals_json) {
        try {
          const parsed = JSON.parse(row.goals_json);
          if (Array.isArray(parsed)) {
            goals = parsed.map(String);
          }
        } catch {
          goals = [];
        }
      }

      return {
        id: Number(row.id),
        goals,
        status: String(row.status),
        project: row.project !== null && row.project !== undefined ? String(row.project) : null,
        started_at: row.started_at ? String(row.started_at) : '',
        ended_at: row.ended_at !== null && row.ended_at !== undefined ? String(row.ended_at) : null,
      };
    },

    startTurn(sessionId: number, seat: Seat, agent: string, taskId: string | null): number {
      const now = new Date().toISOString();
      const info = startTurnStmt.run(sessionId, seat, agent, taskId, now);
      return Number(info.lastInsertRowid);
    },

    endTurn(turnId: number, result: TurnResult, error?: string): void {
      const now = new Date().toISOString();
      endTurnStmt.run(now, result, error ?? null, turnId);
    },

    countTurns(sessionId: number, seat?: Seat): number {
      if (seat !== undefined) {
        const row = countSeatTurnsStmt.get(sessionId, seat) as { count: number };
        return row ? row.count : 0;
      }
      const row = countAllTurnsStmt.get(sessionId) as { count: number };
      return row ? row.count : 0;
    },

    recordHandoffFailure(sessionId: number, taskId: string, reason: string): void {
      const now = new Date().toISOString();
      recordHandoffFailureStmt.run(sessionId, taskId, reason, now);
    },

    setTurnLog(turnId: number, file: string): void {
      setTurnLogStmt.run(file, turnId);
    },

    setTaskState(sessionId: number, taskId: string, state: BoardState, fixRounds: number, baseSha?: string | null): void {
      const now = new Date().toISOString();
      setTaskStateStmt.run(sessionId, taskId, state, fixRounds, baseSha ?? null, now);
    },

    listTaskStates(sessionId: number): { task_id: string; state: BoardState; fix_rounds: number; base_sha?: string | null; updated_at: string }[] {
      const rows = listTaskStatesStmt.all(sessionId) as Array<{
        task_id: string;
        state: string;
        fix_rounds: number;
        base_sha: string | null;
        updated_at: string;
      }>;
      return rows.map((r) => ({
        task_id: String(r.task_id),
        state: r.state as BoardState,
        fix_rounds: Number(r.fix_rounds),
        base_sha: r.base_sha !== null && r.base_sha !== undefined ? String(r.base_sha) : null,
        updated_at: String(r.updated_at),
      }));
    },

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
    }[] {
      const rows = listTurnsStmt.all(sessionId) as Array<{
        id: number;
        seat: string;
        agent: string;
        task_id: string | null;
        started_at: string;
        ended_at: string | null;
        result: string | null;
        error: string | null;
        log_file: string | null;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        seat: r.seat as Seat,
        agent: String(r.agent),
        task_id: r.task_id !== null && r.task_id !== undefined ? String(r.task_id) : null,
        started_at: String(r.started_at),
        ended_at: r.ended_at !== null && r.ended_at !== undefined ? String(r.ended_at) : null,
        result: r.result !== null && r.result !== undefined ? String(r.result) : null,
        error: r.error !== null && r.error !== undefined ? String(r.error) : null,
        log_file: r.log_file !== null && r.log_file !== undefined ? String(r.log_file) : null,
      }));
    },

    listHandoffFailures(sessionId: number): { task_id: string; reason: string; at: string }[] {
      const rows = listHandoffFailuresStmt.all(sessionId) as Array<{
        task_id: string;
        reason: string;
        at: string;
      }>;
      return rows.map((r) => ({
        task_id: String(r.task_id),
        reason: String(r.reason),
        at: String(r.at),
      }));
    },

    enqueue(to: Seat, text: string): number {
      const now = new Date().toISOString();
      const info = enqueueStmt.run(to, text, now);
      return Number(info.lastInsertRowid);
    },

    nextQueuedAsk(): QueueItem | null {
      return (db.prepare(`SELECT id, "to", text, status, created_at FROM queue WHERE status = 'queued' AND "to" LIKE 'ask-%' ORDER BY id ASC LIMIT 1`).get() as QueueItem | undefined) ?? null;
    },

    openTurnAgents(): string[] {
      return (db.prepare('SELECT DISTINCT agent FROM turns WHERE ended_at IS NULL').all() as Array<{ agent: string }>).map((r) => r.agent);
    },

    nextQueued(): QueueItem | null {
      const row = nextQueuedStmt.get() as {
        id: number;
        to: string;
        text: string;
        status: string;
        created_at: string;
      } | undefined;
      if (!row) return null;
      return {
        id: Number(row.id),
        to: row.to as Seat,
        text: String(row.text),
        status: row.status as QueueItem['status'],
        created_at: String(row.created_at),
      };
    },

    setQueueStatus(id: number, s: QueueItem['status']): void {
      setQueueStatusStmt.run(s, id);
    },

    cancelQueued(): number {
      const info = cancelQueuedStmt.run();
      return Number(info.changes);
    },

    listQueue(limit: number): QueueItem[] {
      const rows = listQueueStmt.all(limit) as Array<{
        id: number;
        to: string;
        text: string;
        status: string;
        created_at: string;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        to: r.to as Seat,
        text: String(r.text),
        status: r.status as QueueItem['status'],
        created_at: String(r.created_at),
      }));
    },

    addLineNote(project: string, ticket: string, path: string, line: number, text: string): number {
      const info = db.prepare('INSERT INTO line_notes (project, ticket, path, line, text, used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(project, ticket, path, line, text, new Date().toISOString());
      return Number(info.lastInsertRowid);
    },

    listLineNotes(project: string, ticket: string, onlyUnused = false): LineNote[] {
      const rows = db.prepare(`SELECT id, ticket, path, line, text, used, created_at FROM line_notes WHERE project = ? AND ticket = ?${onlyUnused ? ' AND used = 0' : ''} ORDER BY path, line, id`)
        .all(project, ticket) as Array<Omit<LineNote, 'used'> & { used: number }>;
      return rows.map((r) => ({ ...r, used: r.used === 1 }));
    },

    markLineNotesUsed(project: string, ticket: string): void {
      db.prepare('UPDATE line_notes SET used = 1 WHERE project = ? AND ticket = ? AND used = 0').run(project, ticket);
    },

    addQuestion(project: string, ticket: string, seat: string, agent: string | null, text: string): number {
      const info = db.prepare("INSERT INTO questions (project, ticket, seat, agent, text, state, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)")
        .run(project, ticket, seat, agent, text, new Date().toISOString());
      return Number(info.lastInsertRowid);
    },

    listQuestions(project: string, state?: QuestionState): QuestionRow[] {
      return (state
        ? db.prepare('SELECT * FROM questions WHERE project = ? AND state = ? ORDER BY id').all(project, state)
        : db.prepare('SELECT * FROM questions WHERE project = ? ORDER BY id').all(project)) as QuestionRow[];
    },

    getQuestion(id: number): QuestionRow | null {
      return (db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined) ?? null;
    },

    answerQuestion(id: number, answer: string, image: string | null = null): void {
      db.prepare("UPDATE questions SET answer = ?, image = ?, state = 'answered' WHERE id = ? AND state = 'open'").run(answer, image, id);
    },

    markQuestionsUsed(project: string, ticket: string): void {
      db.prepare("UPDATE questions SET state = 'used' WHERE project = ? AND ticket = ? AND state = 'answered'").run(project, ticket);
    },

    ensureDefaultAccounts(agents: string[]): void {
      const ins = db.prepare("INSERT OR IGNORE INTO accounts (agent, slug, email, label, active, ord, created_at) VALUES (?, 'default', NULL, 'none', 1, 0, ?)");
      const now = new Date().toISOString();
      for (const a of agents) ins.run(a, now);
    },

    listAccounts(agent?: string): AccountRow[] {
      const rows = (agent
        ? db.prepare('SELECT * FROM accounts WHERE agent = ? ORDER BY ord, slug').all(agent)
        : db.prepare('SELECT * FROM accounts ORDER BY agent, ord, slug').all()) as any[];
      return rows.map(toAccount);
    },

    getAccount(agent: string, slug: string): AccountRow | null {
      const row = db.prepare('SELECT * FROM accounts WHERE agent = ? AND slug = ?').get(agent, slug);
      return row ? toAccount(row) : null;
    },

    addAccount(agent, slug, opts): AccountRow {
      const max = db.prepare('SELECT MAX(ord) AS m FROM accounts WHERE agent = ?').get(agent) as { m: number | null };
      db.prepare('INSERT INTO accounts (agent, slug, email, label, active, ord, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(agent, slug, opts.email ?? null, opts.label ?? 'none', opts.active ? 1 : 0, (max.m ?? -1) + 1, new Date().toISOString());
      return toAccount(db.prepare('SELECT * FROM accounts WHERE agent = ? AND slug = ?').get(agent, slug));
    },

    updateAccount(agent, slug, patch): void {
      if (patch.email !== undefined) db.prepare('UPDATE accounts SET email = ? WHERE agent = ? AND slug = ?').run(patch.email, agent, slug);
      if (patch.label !== undefined) db.prepare('UPDATE accounts SET label = ? WHERE agent = ? AND slug = ?').run(patch.label, agent, slug);
      if (patch.active !== undefined) db.prepare('UPDATE accounts SET active = ? WHERE agent = ? AND slug = ?').run(patch.active ? 1 : 0, agent, slug);
    },

    moveAccount(agent, slug, dir): void {
      const list = (db.prepare('SELECT slug, ord FROM accounts WHERE agent = ? ORDER BY ord, slug').all(agent) as Array<{ slug: string; ord: number }>);
      const i = list.findIndex((r) => r.slug === slug);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j]!, list[i]!];
      const upd = db.prepare('UPDATE accounts SET ord = ? WHERE agent = ? AND slug = ?');
      db.transaction(() => list.forEach((r, k) => upd.run(k, agent, r.slug)))();
    },

    getSetting(key: string): string | null {
      const row = getSettingStmt.get(key) as { value: string } | undefined;
      return row ? String(row.value) : null;
    },

    setSetting(key: string, value: string): void {
      setSettingStmt.run(key, String(value));
    },

    setSessionTasks(sessionId: number, taskIds: string[]): void {
      for (const taskId of taskIds) {
        setSessionTaskStmt.run(sessionId, taskId);
      }
    },

    getSessionTasks(sessionId: number): string[] {
      const rows = getSessionTasksStmt.all(sessionId) as Array<{ task_id: string }>;
      return rows.map((r) => String(r.task_id));
    },

    createNote(project: string, text: string, image?: string | null): number {
      const now = new Date().toISOString();
      const info = createNoteStmt.run(project, text, image ?? null, now);
      return Number(info.lastInsertRowid);
    },

    getNote(id: number): NoteRow | null {
      const row = getNoteStmt.get(id) as {
        id: number;
        project: string;
        text: string;
        image: string | null;
        status: string;
        created_at: string;
        session_id: number | null;
      } | undefined;
      if (!row) return null;
      return {
        id: Number(row.id),
        project: String(row.project),
        text: String(row.text),
        image: row.image !== null && row.image !== undefined ? String(row.image) : null,
        status: String(row.status),
        created_at: String(row.created_at),
        session_id: row.session_id !== null && row.session_id !== undefined ? Number(row.session_id) : null,
      };
    },

    setNoteSession(id: number, sessionId: number): void {
      setNoteSessionStmt.run(sessionId, id);
    },

    setNoteStatus(id: number, status: string): void {
      setNoteStatusStmt.run(status, id);
    },

    setNoteImage(id: number, image: string): void {
      setNoteImageStmt.run(image, id);
    },

    listNotes(project?: string, limit = 50): NoteRow[] {
      const rows = (project !== undefined
        ? listNotesByProjectStmt.all(project, limit)
        : listAllNotesStmt.all(limit)) as Array<{
        id: number;
        project: string;
        text: string;
        image: string | null;
        status: string;
        created_at: string;
        session_id: number | null;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        project: String(r.project),
        text: String(r.text),
        image: r.image !== null && r.image !== undefined ? String(r.image) : null,
        status: String(r.status),
        created_at: String(r.created_at),
        session_id: r.session_id !== null && r.session_id !== undefined ? Number(r.session_id) : null,
      }));
    },

    getNotesBySession(sessionId: number): NoteRow[] {
      const rows = getNotesBySessionStmt.all(sessionId) as Array<{
        id: number;
        project: string;
        text: string;
        image: string | null;
        status: string;
        created_at: string;
        session_id: number | null;
      }>;
      return rows.map((r) => ({
        id: Number(r.id),
        project: String(r.project),
        text: String(r.text),
        image: r.image !== null && r.image !== undefined ? String(r.image) : null,
        status: String(r.status),
        created_at: String(r.created_at),
        session_id: r.session_id !== null && r.session_id !== undefined ? Number(r.session_id) : null,
      }));
    },

    deleteNote(id: number): void {
      deleteNoteStmt.run(id);
    },

    saveEnergy(r: EnergyReading): void {
      saveEnergyStmt.run(
        r.agent,
        r.status,
        JSON.stringify(r.windows || []),
        r.readAt,
        r.note ?? null
      );
    },

    latestEnergy(agent: string): EnergyReading | null {
      const row = getLatestEnergyStmt.get(agent) as {
        agent: string;
        status: string;
        windows_json: string;
        read_at: string;
        note: string | null;
      } | undefined;
      if (!row) return null;
      let windows: EnergyWindow[] = [];
      try {
        windows = JSON.parse(row.windows_json);
      } catch {
        windows = [];
      }
      const res: EnergyReading = {
        agent: String(row.agent),
        status: row.status as 'fresh' | 'unknown',
        windows,
        readAt: String(row.read_at),
      };
      if (row.note !== null && row.note !== undefined) {
        res.note = String(row.note);
      }
      return res;
    },

    saveLogin(h: LoginHealth): void {
      const now = new Date().toISOString();
      saveLoginStmt.run(
        h.agent,
        h.state,
        h.detail,
        h.expiresAt ?? null,
        now
      );
    },

    latestLogin(agent: string): LoginHealth | null {
      const row = getLatestLoginStmt.get(agent) as {
        agent: string;
        state: string;
        detail: string;
        expires_at: string | null;
      } | undefined;
      if (!row) return null;
      const res: LoginHealth = {
        agent: String(row.agent),
        state: row.state as LoginState,
        detail: String(row.detail),
      };
      if (row.expires_at !== null && row.expires_at !== undefined) {
        res.expiresAt = String(row.expires_at);
      }
      return res;
    },

    // Plan 4 Task 2:
    createGoal(project: string, title: string): { n: number; branch: string } {
      return createGoalTx(project, title);
    },

    getGoal(project: string, n: number): GoalRow | null {
      const row = getGoalStmt.get(project, n) as GoalRow | undefined;
      return row ?? null;
    },

    listGoals(project: string): GoalRow[] {
      return listGoalsStmt.all(project) as GoalRow[];
    },

    archiveGoal(project: string, n: number): void {
      db.transaction(() => {
        db.prepare('UPDATE goals SET archived_at = ? WHERE project = ? AND n = ?').run(new Date().toISOString(), project, n);
        const now = new Date().toISOString();
        for (const id of sessionsOfGoal(project, n)) {
          db.prepare(`UPDATE sessions SET status = 'refused', ended_at = COALESCE(ended_at, ?) WHERE id = ? AND status IN ('needs_owner','stopped','out_of_turns','awaiting_approval')`).run(now, id);
        }
        const ids = ticketIdsOfGoal(project, n);
        if (ids.length) {
          db.prepare(`UPDATE questions SET state = 'used' WHERE project = ? AND state = 'open' AND ticket IN (${ids.map(() => '?').join(',')})`).run(project, ...ids);
        }
      })();
    },

    restoreGoal(project: string, n: number): void {
      db.prepare('UPDATE goals SET archived_at = NULL WHERE project = ? AND n = ?').run(project, n);
    },

    listArchivedGoals(project: string): GoalRow[] {
      return (listGoalsStmt.all(project) as GoalRow[]).filter((g) => g.archived_at);
    },

    exportGoal(project: string, n: number): Record<string, unknown> {
      const ids = ticketIdsOfGoal(project, n);
      const inIds = ids.length ? `(${ids.map(() => '?').join(',')})` : '(NULL)';
      const sids = sessionsOfGoal(project, n);
      const inS = sids.length ? `(${sids.map(() => '?').join(',')})` : '(NULL)';
      return {
        goal: db.prepare('SELECT * FROM goals WHERE project = ? AND n = ?').get(project, n),
        tickets: db.prepare(`SELECT * FROM tickets WHERE project = ? AND id IN ${inIds}`).all(project, ...ids),
        ticket_history: db.prepare(`SELECT * FROM ticket_history WHERE project = ? AND ticket_id IN ${inIds}`).all(project, ...ids),
        questions: db.prepare(`SELECT * FROM questions WHERE project = ? AND ticket IN ${inIds}`).all(project, ...ids),
        line_notes: db.prepare(`SELECT * FROM line_notes WHERE project = ? AND ticket IN ${inIds}`).all(project, ...ids),
        sessions: db.prepare(`SELECT * FROM sessions WHERE id IN ${inS}`).all(...sids),
        turns: db.prepare(`SELECT * FROM turns WHERE session_id IN ${inS}`).all(...sids),
      };
    },

    purgeGoal(project: string, n: number): void {
      db.transaction(() => {
        const ids = ticketIdsOfGoal(project, n);
        if (ids.length) {
          const q = `(${ids.map(() => '?').join(',')})`;
          db.prepare(`DELETE FROM ticket_history WHERE project = ? AND ticket_id IN ${q}`).run(project, ...ids);
          db.prepare(`DELETE FROM questions WHERE project = ? AND ticket IN ${q}`).run(project, ...ids);
          db.prepare(`DELETE FROM line_notes WHERE project = ? AND ticket IN ${q}`).run(project, ...ids);
          db.prepare(`DELETE FROM tickets WHERE project = ? AND id IN ${q}`).run(project, ...ids);
        }
        for (const sid of sessionsOfGoal(project, n)) {
          for (const t of ['turns', 'task_states', 'session_tasks', 'handoff_failures']) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sid);
          db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
        }
        db.prepare('DELETE FROM goals WHERE project = ? AND n = ?').run(project, n);
        const key = `goal_n_floor:${project}`;
        const cur = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(key, String(Math.max(n, cur ? parseInt(cur.value, 10) || 0 : 0)));
      })();
    },

    goalTurns(project: string, n: number): Array<{ seat: string; agent: string; started_at: string; ended_at: string | null }> {
      const sids = sessionsOfGoal(project, n);
      if (!sids.length) return [];
      return db.prepare(`SELECT seat, agent, started_at, ended_at FROM turns WHERE session_id IN (${sids.map(() => '?').join(',')}) ORDER BY id`).all(...sids) as Array<{ seat: string; agent: string; started_at: string; ended_at: string | null }>;
    },

    sessionGoalNumbers(sessionId: number): number[] {
      const r = db.prepare('SELECT goals_json FROM sessions WHERE id = ?').get(sessionId) as { goals_json: string } | undefined;
      return r ? goalNumsOf(r.goals_json) : [];
    },

    setGoalState(
      project: string,
      n: number,
      state: GoalState,
      by: string,
      reason?: string,
      reviewedSha?: string | null
    ): void {
      const now = new Date().toISOString();
      let shaToStore = reviewedSha;
      if (shaToStore === undefined && (state === 'qc_done' || state === 'audit_passed')) {
        try {
          const goal = getGoalStmt.get(project, n) as GoalRow | undefined;
          if (goal?.branch) {
            shaToStore = git(project, 'rev-parse', `refs/heads/${goal.branch}`).trim();
          }
        } catch {}
      }
      if (shaToStore !== undefined) {
        updateGoalStateWithShaStmt.run(state, now, shaToStore, project, n);
      } else {
        updateGoalStateStmt.run(state, now, project, n);
      }
    },

    upsertTicket(project: string, t: Ticket): void {
      const now = new Date().toISOString();
      upsertTicketStmt.run(
        project,
        t.id,
        t.goal,
        t.number,
        t.of,
        t.title,
        t.type,
        t.size,
        now
      );
    },

    getTicketState(
      project: string,
      id: string
    ): { state: TicketState; fix_rounds: number; base_sha: string | null } | null {
      const row = getTicketStateStmt.get(project, id) as {
        state: TicketState;
        fix_rounds: number;
        base_sha: string | null;
      } | undefined;
      return row ?? null;
    },

    setTicketState(
      project: string,
      id: string,
      to: TicketState,
      by: string,
      reason: string,
      fixRounds?: number,
      baseSha?: string | null
    ): void {
      setTicketStateTx(project, id, to, by, reason, fixRounds, baseSha);
    },

    listTickets(project: string, goal?: string): TicketRow[] {
      if (goal !== undefined) {
        return listTicketsByGoalStmt.all(project, goal) as TicketRow[];
      }
      return listTicketsAllStmt.all(project) as TicketRow[];
    },

    ticketHistory(project: string, id: string): TicketHistoryRow[] {
      return ticketHistoryStmt.all(project, id) as TicketHistoryRow[];
    },

    ticketTurns(project: string, ticketId: string): TicketTurnRow[] {
      return db.prepare(`SELECT t.id, t.seat, t.agent, t.started_at, t.ended_at, t.result, t.error, t.log_file
        FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.project = ? AND t.task_id = ? ORDER BY t.id`).all(project, ticketId) as TicketTurnRow[];
    },

    turnLogFile(project: string, turnId: number): string | null {
      const r = db.prepare(`SELECT t.log_file FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.project = ? AND t.id = ?`).get(project, turnId) as { log_file: string | null } | undefined;
      return r?.log_file ?? null;
    },

    nextTicketSeq(project: string): number {
      const row = getNextTicketSeqStmt.get(project) as { next_ticket_seq: number } | undefined;
      return row ? row.next_ticket_seq : 1;
    },

    bumpTicketSeq(project: string, usedMax: number): void {
      const current = this.nextTicketSeq(project);
      const next = Math.max(current, usedMax + 1);
      bumpTicketSeqStmt.run(project, next);
    },

    close(): void {
      openStores.delete(storeObj);
      db.close();
    },
  };

  openStores.add(storeObj);
  return storeObj;
}