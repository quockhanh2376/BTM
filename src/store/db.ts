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

export type TurnResult = 'ok' | 'timeout' | 'error' | 'rejected';
export type BoardState = 'pending' | 'in_dev' | 'awaiting_qc' | 'passed' | 'returned' | 'failed' | 'blocked';
export type GoalState = 'open' | 'in_progress' | 'qc_done' | 'audit_passed' | 'approved' | 'merged';

export interface GoalRow {
  n: number;
  title: string;
  state: GoalState;
  branch: string;
  created_at: string;
  updated_at: string;
  reviewed_sha?: string | null;
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
  setQueueStatus(id: number, s: QueueItem['status']): void;
  cancelQueued(): number;
  listQueue(limit: number): QueueItem[];

  /** Đổi đường dẫn project ở mọi bảng + key setting `…:<path>` (btm isolate). */
  renameProject(oldPath: string, newPath: string): void;
  getSetting(key: string): string | null;
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
  setGoalState(project: string, n: number, state: GoalState, by: string, reason?: string, reviewedSha?: string | null): void;
  upsertTicket(project: string, t: Ticket): void;
  getTicketState(project: string, id: string): { state: TicketState; fix_rounds: number; base_sha: string | null } | null;
  setTicketState(project: string, id: string, to: TicketState, by: string, reason: string, fixRounds?: number, baseSha?: string | null): void;
  listTickets(project: string, goal?: string): TicketRow[];
  ticketHistory(project: string, id: string): TicketHistoryRow[];
  nextTicketSeq(project: string): number;
  bumpTicketSeq(project: string, usedMax: number): void;

  close(): void;
}

const SEATS: Seat[] = ['pm', 'dev', 'qc', 'audit'];

export function seatSettingKey(project: string | null | undefined, seat: Seat): string {
  return project ? `seat:${project}:${seat}` : `seat:${seat}`;
}

type SeatCfg = {
  seats: Record<Seat, string>;
  agents?: Record<string, { can_sit: Seat[] }>;
  git?: { protected_branch?: string };
};

const projectSeatsCache = new Map<string, { sha: string; seats: Partial<Record<Seat, string>>; backups: Partial<Record<Seat, string[]>>; warn: string[] }>();

// Đội hình theo project trong team/project.yaml – đọc từ nhánh được bảo vệ (main), không từ working tree:
// agent sửa được working tree nhưng không sửa được main.
export function readProjectSeats(repo: string, protectedBranch = 'main'): { seats: Partial<Record<Seat, string>>; backups: Partial<Record<Seat, string[]>>; warnings: string[] } {
  let sha: string;
  try {
    sha = git(repo, 'rev-parse', '-q', '--verify', `refs/heads/${protectedBranch}^{commit}`).trim();
  } catch {
    return { seats: {}, backups: {}, warnings: [] };
  }
  const hit = projectSeatsCache.get(repo);
  if (hit && hit.sha === sha) return { seats: hit.seats, backups: hit.backups, warnings: hit.warn };
  let seats: Partial<Record<Seat, string>> = {};
  let backups: Partial<Record<Seat, string[]>> = {};
  const warn: string[] = [];
  let text = '';
  try {
    text = git(repo, 'show', `${sha}:team/project.yaml`);
  } catch {
    text = '';
  }
  if (text) {
    try {
      const doc = parseYaml(text) as { seats?: unknown; seats_backup?: unknown } | null;
      const raw = doc && typeof doc === 'object' ? doc.seats : undefined;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'object' || Array.isArray(raw)) {
          warn.push('team/project.yaml: seats must map seat → agent');
        } else {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if ((SEATS as string[]).includes(k) && typeof v === 'string') seats[k as Seat] = v.trim();
            else warn.push(`team/project.yaml: ignored seats.${k}`);
          }
        }
      }
      // Plan 6 Task 2: seats_backup theo project (ghi đè btm.config.yaml), cùng nguồn main.
      const rawB = doc && typeof doc === 'object' ? doc.seats_backup : undefined;
      if (rawB && typeof rawB === 'object' && !Array.isArray(rawB)) {
        for (const [k, v] of Object.entries(rawB as Record<string, unknown>)) {
          if ((SEATS as string[]).includes(k) && Array.isArray(v) && v.every((x) => typeof x === 'string')) backups[k as Seat] = v as string[];
          else warn.push(`team/project.yaml: ignored seats_backup.${k}`);
        }
      }
    } catch {
      seats = {};
      backups = {};
      warn.push('team/project.yaml: invalid YAML, using default team');
    }
  }
  projectSeatsCache.set(repo, { sha, seats, backups, warn });
  return { seats, backups, warnings: warn };
}

// Thứ tự: dashboard theo project > team/project.yaml (main) > dashboard cũ (không theo project) > btm.config.yaml.
// Agent lạ hoặc không có ghế trong can_sit → bỏ qua, ghi cảnh báo. Áp cho cả 4 ghế (audit '' = không có Audit).
export function resolveSeats(
  cfg: SeatCfg,
  store?: Pick<Store, 'getSetting'> & Partial<Pick<Store, 'getActiveProject'>> | null,
  project?: string | null
): { seats: Record<Seat, string>; warnings: string[] } {
  const seats: Record<Seat, string> = { ...cfg.seats };
  const warnings: string[] = [];
  const proj = project ?? store?.getActiveProject?.() ?? null;
  const valid = (seat: Seat, id: string) =>
    !cfg.agents || (Object.hasOwn(cfg.agents, id) && Boolean(cfg.agents[id]?.can_sit?.includes(seat)));
  const apply = (seat: Seat, id: string | null | undefined, source: string) => {
    if (!id) return;
    if (valid(seat, id)) seats[seat] = id;
    else warnings.push(`Ignored ${source}: ${seat} = "${id}" (unknown or not allowed)`);
  };
  const fromFile = proj ? readProjectSeats(proj, cfg.git?.protected_branch || 'main') : { seats: {}, backups: {}, warnings: [] };
  warnings.push(...fromFile.warnings);
  for (const seat of SEATS) {
    apply(seat, store?.getSetting(seatSettingKey(null, seat)), 'legacy override');
    apply(seat, fromFile.seats[seat], 'team/project.yaml');
    if (proj) apply(seat, store?.getSetting(seatSettingKey(proj, seat)), 'dashboard override');
  }
  return { seats, warnings };
}

export function effectiveSeats(
  cfg: SeatCfg,
  store?: Pick<Store, 'getSetting'> & Partial<Pick<Store, 'getActiveProject'>> | null,
  project?: string | null
): Record<Seat, string> {
  return resolveSeats(cfg, store, project).seats;
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
      base_sha TEXT,
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

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      text TEXT NOT NULL,
      image TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      session_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS energy_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      windows_json TEXT NOT NULL,
      read_at TEXT NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS login_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      state TEXT NOT NULL,
      detail TEXT NOT NULL,
      expires_at TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goals (
      project TEXT NOT NULL,
      n INTEGER NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_sha TEXT,
      PRIMARY KEY (project, n)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      project TEXT NOT NULL,
      id TEXT NOT NULL,
      goal TEXT NOT NULL,
      number INTEGER NOT NULL,
      of INTEGER NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      size TEXT NOT NULL,
      state TEXT NOT NULL,
      fix_rounds INTEGER NOT NULL DEFAULT 0,
      base_sha TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project, id)
    );

    CREATE TABLE IF NOT EXISTS ticket_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      by TEXT NOT NULL,
      reason TEXT NOT NULL,
      at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_counters (
      project TEXT PRIMARY KEY,
      next_ticket_seq INTEGER NOT NULL
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

  const taskStateCols = db.pragma('table_info(task_states)') as Array<{ name: string }>;
  const hasBaseSha = taskStateCols.some((c) => c.name.toLowerCase() === 'base_sha');
  if (!hasBaseSha) {
    db.exec('ALTER TABLE task_states ADD COLUMN base_sha TEXT');
  }

  const goalCols = db.pragma('table_info(goals)') as Array<{ name: string }>;
  const hasReviewedSha = goalCols.some((c) => c.name.toLowerCase() === 'reviewed_sha');
  if (!hasReviewedSha) {
    db.exec('ALTER TABLE goals ADD COLUMN reviewed_sha TEXT');
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
    SELECT n, title, state, branch, created_at, updated_at, reviewed_sha
    FROM goals
    WHERE project = ? AND n = ?
  `);

  const listGoalsStmt = db.prepare(`
    SELECT n, title, state, branch, created_at, updated_at, reviewed_sha
    FROM goals
    WHERE project = ?
    ORDER BY n ASC
  `);

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
    const n = (row?.max_n ?? 0) + 1;
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
    for (const t of ['sessions', 'notes', 'goals', 'tickets', 'ticket_history', 'project_counters']) {
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