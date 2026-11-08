import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Seat } from '../config.ts';

export type TurnResult = 'ok' | 'timeout' | 'error' | 'rejected';

export interface Store {
  setActiveProject(path: string): void;
  getActiveProject(): string | null;
  createSession(goals: string[]): number;
  setSessionStatus(id: number, status: string): void;
  startTurn(sessionId: number, seat: Seat, agent: string, taskId: string | null): number;
  endTurn(turnId: number, result: TurnResult, error?: string): void;
  countTurns(sessionId: number, seat?: Seat): number;
  recordHandoffFailure(sessionId: number, taskId: string, reason: string): void;
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
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS handoff_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);

  const setActiveProjectStmt = db.prepare(`
    INSERT INTO active_project (id, path) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path
  `);

  const getActiveProjectStmt = db.prepare(`
    SELECT path FROM active_project WHERE id = 1
  `);

  const createSessionStmt = db.prepare(`
    INSERT INTO sessions (goals_json, status, started_at, ended_at)
    VALUES (?, 'running', ?, NULL)
  `);

  const updateSessionStatusTerminalStmt = db.prepare(`
    UPDATE sessions SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?
  `);

  const updateSessionStatusStmt = db.prepare(`
    UPDATE sessions SET status = ? WHERE id = ?
  `);

  const startTurnStmt = db.prepare(`
    INSERT INTO turns (session_id, seat, agent, task_id, started_at, ended_at, result, error)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
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

  return {
    setActiveProject(path: string): void {
      setActiveProjectStmt.run(path);
    },

    getActiveProject(): string | null {
      const row = getActiveProjectStmt.get() as { path: string } | undefined;
      return row ? row.path : null;
    },

    createSession(goals: string[]): number {
      const now = new Date().toISOString();
      const info = createSessionStmt.run(JSON.stringify(goals), now);
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

    close(): void {
      db.close();
    },
  };
}
