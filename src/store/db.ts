import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Seat } from '../config.ts';

export type TurnResult = 'ok' | 'timeout' | 'error' | 'rejected';
export type BoardState = 'pending' | 'in_dev' | 'awaiting_qc' | 'passed' | 'returned' | 'failed' | 'blocked';

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
  setTaskState(sessionId: number, taskId: string, state: BoardState, fixRounds: number): void;
  listTaskStates(sessionId: number): { task_id: string; state: BoardState; fix_rounds: number; updated_at: string }[];
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
  setQueueStatus(id: number, s: QueueItem['status']): void;
  cancelQueued(): number;
  listQueue(limit: number): QueueItem[];

  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  setSessionTasks(sessionId: number, taskIds: string[]): void;
  getSessionTasks(sessionId: number): string[];

  close(): void;
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS active_project (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      goals_json TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      seat TEXT NOT NULL,
      agent TEXT NOT NULL,
      task_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      result TEXT,
      error TEXT,
      log_file TEXT
    );

    CREATE TABLE IF NOT EXISTS handoff_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_states (
      session_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      state TEXT NOT NULL,
      fix_rounds INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "to" TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_tasks (
      session_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      PRIMARY KEY (session_id, task_id)
    );
  `);

  const sessionCols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  const hasProject = sessionCols.some((c) => c.name.toLowerCase() === 'project');
  if (!hasProject) {
    db.exec('ALTER TABLE sessions ADD COLUMN project TEXT');
  }

  const turnCols = db.pragma('table_info(turns)') as Array<{ name: string }>;
  const hasLogFile = turnCols.some((c) => c.name.toLowerCase() === 'log_file');
  if (!hasLogFile) {
    db.exec('ALTER TABLE turns ADD COLUMN log_file TEXT');
  }

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

  const countAllTurnsStmt = db.prepare(`
    SELECT COUNT(*) as count FROM turns WHERE session_id = ?
  `);

  const countSeatTurnsStmt = db.prepare(`
    SELECT COUNT(*) as count FROM turns WHERE session_id = ? AND seat = ?
  `);

  const recordHandoffFailureStmt = db.prepare(`
    INSERT INTO handoff_failures (session_id, task_id, reason, at)
    VALUES (?, ?, ?, ?)
  `);

  const setTurnLogStmt = db.prepare(`
    UPDATE turns SET log_file = ? WHERE id = ?
  `);

  const setTaskStateStmt = db.prepare(`
    INSERT INTO task_states (session_id, task_id, state, fix_rounds, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, task_id) DO UPDATE SET
      state = excluded.state,
      fix_rounds = excluded.fix_rounds,
      updated_at = excluded.updated_at
  `);

  const listTaskStatesStmt = db.prepare(`
    SELECT task_id, state, fix_rounds, updated_at
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

  const nextQueuedStmt = db.prepare(`
    SELECT id, "to", text, status, created_at
    FROM queue
    WHERE status = 'queued'
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

  return {
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

    setTaskState(sessionId: number, taskId: string, state: BoardState, fixRounds: number): void {
      const now = new Date().toISOString();
      setTaskStateStmt.run(sessionId, taskId, state, fixRounds, now);
    },

    listTaskStates(sessionId: number): { task_id: string; state: BoardState; fix_rounds: number; updated_at: string }[] {
      const rows = listTaskStatesStmt.all(sessionId) as Array<{
        task_id: string;
        state: string;
        fix_rounds: number;
        updated_at: string;
      }>;
      return rows.map((r) => ({
        task_id: String(r.task_id),
        state: r.state as BoardState,
        fix_rounds: Number(r.fix_rounds),
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

    close(): void {
      db.close();
    },
  };
}