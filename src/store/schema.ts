// Schema SQLite + migration của BTM (tách từ db.ts 2026-11-14). Thêm cột mới: thêm migration ở cuối, kiểm cột trước.
import type Database from 'better-sqlite3';

export function migrate(db: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS line_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      ticket TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      text TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      agent TEXT NOT NULL,
      slug TEXT NOT NULL,
      email TEXT,
      label TEXT NOT NULL DEFAULT 'none',
      active INTEGER NOT NULL,
      ord INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      tool TEXT,
      PRIMARY KEY (agent, slug)
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      ticket TEXT NOT NULL,
      seat TEXT NOT NULL,
      agent TEXT,
      text TEXT NOT NULL,
      answer TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL
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

  const questionCols = db.pragma('table_info(questions)') as Array<{ name: string }>;
  if (!questionCols.some((c) => c.name.toLowerCase() === 'image')) {
    db.exec('ALTER TABLE questions ADD COLUMN image TEXT');
  }

  // Anh Zon 2026-11-14: một Worker dùng nhiều công cụ → công cụ gắn theo tài khoản (null = công cụ của Worker).
  const accountCols = db.pragma('table_info(accounts)') as Array<{ name: string }>;
  if (!accountCols.some((c) => c.name.toLowerCase() === 'tool')) {
    db.exec('ALTER TABLE accounts ADD COLUMN tool TEXT');
  }

  const goalCols = db.pragma('table_info(goals)') as Array<{ name: string }>;
  const hasReviewedSha = goalCols.some((c) => c.name.toLowerCase() === 'reviewed_sha');
  if (!hasReviewedSha) {
    db.exec('ALTER TABLE goals ADD COLUMN reviewed_sha TEXT');
  }
  if (!goalCols.some((c) => c.name.toLowerCase() === 'archived_at')) {
    db.exec('ALTER TABLE goals ADD COLUMN archived_at TEXT');
  }

}
