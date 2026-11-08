import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore, type Store, type BoardState, type QueueItem } from '../src/store/db.ts';

describe('Store SQLite', () => {
  describe('in-memory store', () => {
    let store: Store;

    beforeEach(() => {
      store = openStore(':memory:');
    });

    afterEach(() => {
      store.close();
    });

    it('active project starts empty and can be set and overwritten with exactly 1 row', () => {
      expect(store.getActiveProject()).toBeNull();

      store.setActiveProject('/srv/agent-projects/proj-1');
      expect(store.getActiveProject()).toBe('/srv/agent-projects/proj-1');

      // Overwrite active project
      store.setActiveProject('/srv/agent-projects/proj-2');
      expect(store.getActiveProject()).toBe('/srv/agent-projects/proj-2');
    });

    it('creates sessions and updates session status', () => {
      const s1 = store.createSession(['Goal 1', 'Goal 2']);
      expect(typeof s1).toBe('number');
      expect(s1).toBeGreaterThan(0);

      const s2 = store.createSession(['Goal 3']);
      expect(s2).toBeGreaterThan(s1);

      // Updating session status
      store.setSessionStatus(s1, 'done');
      store.setSessionStatus(s2, 'out_of_turns');
    });

    it('getLatestSession returns latest session or latest by status and project', () => {
      expect(store.getLatestSession()).toBeNull();
      expect(store.getLatestSession('awaiting_approval')).toBeNull();

      const s1 = store.createSession(['Goal 1']);
      store.setSessionStatus(s1, 'awaiting_approval');

      const s2 = store.createSession(['Goal 2']);
      store.setSessionStatus(s2, 'done');

      expect(store.getLatestSession()).toEqual({ id: s2, status: 'done' });
      expect(store.getLatestSession('awaiting_approval')).toEqual({ id: s1, status: 'awaiting_approval' });
      expect(store.getLatestSession('done')).toEqual({ id: s2, status: 'done' });
      expect(store.getLatestSession('needs_owner')).toBeNull();

      // Sessions with project
      const s3 = store.createSession(['Goal 3'], '/path/to/project-alpha');
      store.setSessionStatus(s3, 'awaiting_approval');

      const s4 = store.createSession(['Goal 4'], '/path/to/project-beta');
      store.setSessionStatus(s4, 'awaiting_approval');

      const s5 = store.createSession(['Goal 5'], '/path/to/project-alpha');
      store.setSessionStatus(s5, 'done');

      // getLatestSession with project filter
      expect(store.getLatestSession(undefined, '/path/to/project-alpha')).toEqual({
        id: s5,
        status: 'done',
        project: '/path/to/project-alpha',
      });
      expect(store.getLatestSession('awaiting_approval', '/path/to/project-alpha')).toEqual({
        id: s3,
        status: 'awaiting_approval',
        project: '/path/to/project-alpha',
      });
      expect(store.getLatestSession('awaiting_approval', '/path/to/project-beta')).toEqual({
        id: s4,
        status: 'awaiting_approval',
        project: '/path/to/project-beta',
      });
      expect(store.getLatestSession('awaiting_approval', '/path/to/project-gamma')).toBeNull();
      expect(store.getLatestSession('done', '/path/to/project-beta')).toBeNull();
    });

    it('starts turns, ends turns with result and error, and counts turns by seat', () => {
      const s1 = store.createSession(['Goal 1']);
      const s2 = store.createSession(['Goal 2']);

      expect(store.countTurns(s1)).toBe(0);
      expect(store.countTurns(s1, 'dev')).toBe(0);

      // Start PM turn (taskId can be null)
      const t1 = store.startTurn(s1, 'pm', 'elon', null);
      expect(typeof t1).toBe('number');
      store.endTurn(t1, 'ok');

      // Start Dev turns
      const t2 = store.startTurn(s1, 'dev', 'jacky', 'T-001');
      store.endTurn(t2, 'rejected', 'scope violation: ../secret');

      const t3 = store.startTurn(s1, 'dev', 'jacky', 'T-001');
      store.endTurn(t3, 'ok');

      // Start QC turn
      const t4 = store.startTurn(s1, 'qc', 'jenny', 'T-001');
      store.endTurn(t4, 'timeout', 'Agent process timed out after 10m');

      // Start turn on another session
      const t5 = store.startTurn(s2, 'dev', 'jacky', 'T-002');
      store.endTurn(t5, 'ok');

      // Check counts for session 1
      expect(store.countTurns(s1)).toBe(4);
      expect(store.countTurns(s1, 'dev')).toBe(2);
      expect(store.countTurns(s1, 'pm')).toBe(1);
      expect(store.countTurns(s1, 'qc')).toBe(1);

      // Check counts for session 2
      expect(store.countTurns(s2)).toBe(1);
      expect(store.countTurns(s2, 'dev')).toBe(1);
      expect(store.countTurns(s2, 'pm')).toBe(0);

      // Check count for non-existent session
      expect(store.countTurns(999)).toBe(0);
      expect(store.countTurns(999, 'dev')).toBe(0);
    });

    it('records handoff failures', () => {
      const s1 = store.createSession(['Goal 1']);
      expect(() => {
        store.recordHandoffFailure(s1, 'T-001', 'out_of_scope: modified outside.txt');
      }).not.toThrow();
    });
  });

  describe('file-based store and persistence', () => {
    const tempDirs: string[] = [];

    const createTempDbFile = (): string => {
      const file = join(mkdtempSync(join(tmpdir(), 'btm-')), 't.db');
      tempDirs.push(dirname(file));
      return file;
    };

    afterEach(() => {
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir && existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it('sets and overwrites active project, persisting exactly 1 row with path /b', () => {
      const file = join(mkdtempSync(join(tmpdir(), 'btm-')), 't.db');
      tempDirs.push(dirname(file));

      const store = openStore(file);
      store.setActiveProject('/a');
      store.setActiveProject('/b');

      const directDb = new Database(file);
      const countRow = directDb.prepare('SELECT COUNT(*) as count FROM active_project').get() as { count: number };
      expect(countRow.count).toBe(1);

      const rawCount = Object.values(directDb.prepare('SELECT COUNT(*) FROM active_project').get() as Record<string, number>)[0];
      expect(rawCount).toBe(1);

      const projectRow = directDb.prepare('SELECT path FROM active_project').get() as { path: string };
      expect(projectRow.path).toBe('/b');

      directDb.close();
      store.close();
    });

    it('records ISO 8601 timestamps for started_at and ended_at in turns table', () => {
      const file = join(mkdtempSync(join(tmpdir(), 'btm-')), 't.db');
      tempDirs.push(dirname(file));

      const store = openStore(file);
      const sessionId = store.createSession(['Test ISO timestamps']);
      const turnId = store.startTurn(sessionId, 'dev', 'jacky', 'T-001');
      store.endTurn(turnId, 'ok');

      const directDb = new Database(file);
      const turnRow = directDb.prepare('SELECT started_at, ended_at FROM turns WHERE id = ?').get(turnId) as {
        started_at: string;
        ended_at: string;
      };

      expect(new Date(turnRow.started_at).toISOString() === turnRow.started_at).toBe(true);
      expect(new Date(turnRow.started_at).toISOString()).toBe(turnRow.started_at);
      expect(new Date(turnRow.ended_at).toISOString() === turnRow.ended_at).toBe(true);
      expect(new Date(turnRow.ended_at).toISOString()).toBe(turnRow.ended_at);

      directDb.close();
      store.close();
    });

    it('creates file and directories, enables WAL mode, and preserves data across re-opening', () => {
      const dbPath = createTempDbFile();

      // Phase 1: Open fresh store, write data
      const store1 = openStore(dbPath);
      store1.setActiveProject('/srv/agent-projects/moon');
      const s1 = store1.createSession(['Reach the moon']);
      const t1 = store1.startTurn(s1, 'pm', 'elon', null);
      store1.endTurn(t1, 'ok');
      const t2 = store1.startTurn(s1, 'dev', 'jacky', 'T-001');
      store1.endTurn(t2, 'rejected', 'failed gate diff');
      store1.recordHandoffFailure(s1, 'T-001', 'diff_empty');
      store1.setSessionStatus(s1, 'done');
      store1.close();

      // Check WAL mode directly via better-sqlite3
      const directDb = new Database(dbPath);
      const pragmaResult = directDb.pragma('journal_mode', { simple: true });
      expect(pragmaResult).toBe('wal');

      // Verify active_project has exactly 1 row
      const countRow = directDb.prepare('SELECT count(*) as count FROM active_project').get() as { count: number };
      expect(countRow.count).toBe(1);

      // Verify handoff_failures table contents
      const failureRow = directDb.prepare('SELECT * FROM handoff_failures WHERE session_id = ?').get(s1) as {
        task_id: string;
        reason: string;
        at: string;
      };
      expect(failureRow.task_id).toBe('T-001');
      expect(failureRow.reason).toBe('diff_empty');
      expect(typeof failureRow.at).toBe('string');
      expect(new Date(failureRow.at).toISOString() === failureRow.at).toBe(true);

      // Verify turns table contents including result and error
      const turnRow = directDb.prepare('SELECT * FROM turns WHERE id = ?').get(t2) as {
        result: string;
        error: string;
        started_at: string;
        ended_at: string;
      };
      expect(turnRow.result).toBe('rejected');
      expect(turnRow.error).toBe('failed gate diff');
      expect(new Date(turnRow.started_at).toISOString() === turnRow.started_at).toBe(true);
      expect(new Date(turnRow.started_at).toISOString()).toBe(turnRow.started_at);
      expect(new Date(turnRow.ended_at).toISOString() === turnRow.ended_at).toBe(true);
      expect(new Date(turnRow.ended_at).toISOString()).toBe(turnRow.ended_at);

      // Verify sessions table contents
      const sessionRow = directDb.prepare('SELECT * FROM sessions WHERE id = ?').get(s1) as {
        goals_json: string;
        status: string;
        started_at: string;
        ended_at: string;
      };
      expect(sessionRow.status).toBe('done');
      expect(JSON.parse(sessionRow.goals_json)).toEqual(['Reach the moon']);
      expect(typeof sessionRow.started_at).toBe('string');
      expect(typeof sessionRow.ended_at).toBe('string');
      expect(new Date(sessionRow.started_at).toISOString() === sessionRow.started_at).toBe(true);
      expect(new Date(sessionRow.ended_at).toISOString() === sessionRow.ended_at).toBe(true);

      directDb.close();

      // Phase 2: Re-open with openStore and verify store API
      const store2 = openStore(dbPath);
      expect(store2.getActiveProject()).toBe('/srv/agent-projects/moon');
      expect(store2.countTurns(s1)).toBe(2);
      expect(store2.countTurns(s1, 'pm')).toBe(1);
      expect(store2.countTurns(s1, 'dev')).toBe(1);
      expect(store2.countTurns(s1, 'qc')).toBe(0);

      // Verify we can continue adding data
      const t3 = store2.startTurn(s1, 'qc', 'jenny', 'T-001');
      store2.endTurn(t3, 'ok');
      expect(store2.countTurns(s1)).toBe(3);
      expect(store2.countTurns(s1, 'qc')).toBe(1);

      store2.close();
    });

    it('DB cũ không có cột sessions.project vẫn mở được qua openStore và tự động migrate', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'btm-old-store-'));
      const dbPath = join(tmpDir, 'old-btm.db');

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          goals_json TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        INSERT INTO sessions (goals_json, status, started_at)
        VALUES ('["old goal"]', 'awaiting_approval', '2026-01-01T00:00:00Z');
      `);
      rawDb.close();

      const oldStore = openStore(dbPath);
      expect(oldStore).toBeDefined();

      // Old session can be read without crashing
      const oldSession = oldStore.getSession(1);
      expect(oldSession).toEqual({
        id: 1,
        goals: ['old goal'],
        status: 'awaiting_approval',
        project: null,
        started_at: '2026-01-01T00:00:00Z',
        ended_at: null,
      });

      // New session with project can be created and queried
      const s2 = oldStore.createSession(['New goal'], '/srv/agent-projects/proj-new');
      expect(s2).toBe(2);

      const latestNew = oldStore.getLatestSession(undefined, '/srv/agent-projects/proj-new');
      expect(latestNew).toEqual({
        id: 2,
        status: 'running',
        project: '/srv/agent-projects/proj-new',
      });

      oldStore.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('DB cũ (schema Kế hoạch 1 không có log_file, task_states, queue) mở được và dùng được các hàm mới', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'btm-old-p1-'));
      const dbPath = join(tmpDir, 'old-p1.db');

      // Khởi tạo DB với đúng schema Kế hoạch 1 (chưa có turns.log_file, chưa có task_states, chưa có queue)
      const rawDb = new Database(dbPath);
      rawDb.exec(`
        CREATE TABLE active_project (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          path TEXT NOT NULL
        );
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          goals_json TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE TABLE turns (
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
        CREATE TABLE handoff_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          at TEXT NOT NULL
        );
        INSERT INTO sessions (project, goals_json, status, started_at)
        VALUES ('/srv/agent-projects/legacy', '["legacy goal 1", "legacy goal 2"]', 'running', '2026-11-01T10:00:00.000Z');
        INSERT INTO turns (session_id, seat, agent, task_id, started_at)
        VALUES (1, 'dev', 'jacky', 'T-001', '2026-11-01T10:01:00.000Z');
      `);
      rawDb.close();

      const store = openStore(dbPath);

      // getSession đọc lại session cũ đầy đủ các trường
      const sess = store.getSession(1);
      expect(sess).toEqual({
        id: 1,
        goals: ['legacy goal 1', 'legacy goal 2'],
        status: 'running',
        project: '/srv/agent-projects/legacy',
        started_at: '2026-11-01T10:00:00.000Z',
        ended_at: null,
      });

      // listTurns lúc đầu có log_file là null
      const turnsInitial = store.listTurns(1);
      expect(turnsInitial).toHaveLength(1);
      expect(turnsInitial[0]).toMatchObject({
        id: 1,
        seat: 'dev',
        agent: 'jacky',
        task_id: 'T-001',
        log_file: null,
      });

      // setTurnLog ghi log_file cho turn đã có
      store.setTurnLog(1, '/var/log/btm/turn-1.log');
      const turnsAfterLog = store.listTurns(1);
      expect(turnsAfterLog[0].log_file).toBe('/var/log/btm/turn-1.log');

      // setTaskState và listTaskStates trên bảng task_states vừa được migrate
      store.setTaskState(1, 'T-001', 'pending', 0);
      const states = store.listTaskStates(1);
      expect(states).toHaveLength(1);
      expect(states[0].task_id).toBe('T-001');
      expect(states[0].state).toBe('pending');
      expect(states[0].fix_rounds).toBe(0);

      // enqueue và nextQueued trên bảng queue vừa được migrate
      const qId = store.enqueue('dev', 'Fix something');
      expect(typeof qId).toBe('number');
      const item = store.nextQueued();
      expect(item).toMatchObject({
        id: qId,
        to: 'dev',
        text: 'Fix something',
        status: 'queued',
      });

      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('setTaskState gọi 2 lần cùng task → 1 dòng, state mới (upsert)', () => {
      const dbPath = createTempDbFile();
      const store = openStore(dbPath);
      const sId = store.createSession(['Goal 1']);

      store.setTaskState(sId, 'T-001', 'pending', 0);
      let states = store.listTaskStates(sId);
      expect(states).toHaveLength(1);
      expect(states[0].task_id).toBe('T-001');
      expect(states[0].state).toBe('pending');
      expect(states[0].fix_rounds).toBe(0);

      // Gọi lần 2 với cùng task_id T-001 -> cập nhật state thành in_dev, fix_rounds thành 1
      store.setTaskState(sId, 'T-001', 'in_dev', 1);
      states = store.listTaskStates(sId);
      expect(states).toHaveLength(1);
      expect(states[0].task_id).toBe('T-001');
      expect(states[0].state).toBe('in_dev');
      expect(states[0].fix_rounds).toBe(1);

      // Thêm task khác thì tăng số dòng
      store.setTaskState(sId, 'T-002', 'pending', 0);
      states = store.listTaskStates(sId);
      expect(states).toHaveLength(2);

      store.close();
    });

    it('cancelQueued chỉ hủy queued, không đụng running', () => {
      const dbPath = createTempDbFile();
      const store = openStore(dbPath);

      const id1 = store.enqueue('dev', 'command 1');
      const id2 = store.enqueue('qc', 'command 2');
      const id3 = store.enqueue('dev', 'command 3');

      // Đặt id2 thành 'running'
      store.setQueueStatus(id2, 'running');

      // Hủy các mục đang queued
      const cancelledCount = store.cancelQueued();
      expect(cancelledCount).toBe(2);

      // Kiểm tra trạng thái từng mục qua listQueue
      const items = store.listQueue(10);
      expect(items).toHaveLength(3);
      const item1 = items.find((i) => i.id === id1);
      const item2 = items.find((i) => i.id === id2);
      const item3 = items.find((i) => i.id === id3);

      expect(item1?.status).toBe('cancelled');
      expect(item2?.status).toBe('running');
      expect(item3?.status).toBe('cancelled');

      // nextQueued không còn mục nào vì 2 mục bị cancelled, 1 mục running
      expect(store.nextQueued()).toBeNull();

      store.close();
    });

    it('nextQueued trả mục cũ nhất (FIFO)', () => {
      const dbPath = createTempDbFile();
      const store = openStore(dbPath);

      const id1 = store.enqueue('pm', 'plan A');
      const id2 = store.enqueue('dev', 'code B');
      const id3 = store.enqueue('qc', 'test C');

      // Mục cũ nhất phải là id1
      const first = store.nextQueued();
      expect(first?.id).toBe(id1);
      expect(first?.to).toBe('pm');
      expect(first?.text).toBe('plan A');

      // Khi id1 xong, mục tiếp theo là id2
      store.setQueueStatus(id1, 'done');
      const second = store.nextQueued();
      expect(second?.id).toBe(id2);
      expect(second?.to).toBe('dev');

      // Khi id2 đang chạy, mục tiếp theo là id3
      store.setQueueStatus(id2, 'running');
      const third = store.nextQueued();
      expect(third?.id).toBe(id3);
      expect(third?.to).toBe('qc');

      // Khi id3 xong, không còn mục nào
      store.setQueueStatus(id3, 'done');
      expect(store.nextQueued()).toBeNull();

      store.close();
    });

    it('listTurns, listHandoffFailures, listQueue và getSession hoạt động chuẩn xác', () => {
      const dbPath = createTempDbFile();
      const store = openStore(dbPath);

      // getSession không tồn tại trả về null
      expect(store.getSession(999)).toBeNull();

      const sId = store.createSession(['Build lunar module'], '/srv/agent-projects/moon');
      const t1 = store.startTurn(sId, 'pm', 'elon', null);
      store.setTurnLog(t1, '/tmp/turn-pm.log');
      store.endTurn(t1, 'ok');

      const t2 = store.startTurn(sId, 'dev', 'jacky', 'T-001');
      store.endTurn(t2, 'rejected', 'out of scope');

      store.recordHandoffFailure(sId, 'T-001', 'scope violation');

      const turns = store.listTurns(sId);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        id: t1,
        seat: 'pm',
        agent: 'elon',
        task_id: null,
        result: 'ok',
        log_file: '/tmp/turn-pm.log',
      });
      expect(turns[1]).toMatchObject({
        id: t2,
        seat: 'dev',
        agent: 'jacky',
        task_id: 'T-001',
        result: 'rejected',
        error: 'out of scope',
        log_file: null,
      });

      const failures = store.listHandoffFailures(sId);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        task_id: 'T-001',
        reason: 'scope violation',
      });

      const sess = store.getSession(sId);
      expect(sess).toEqual({
        id: sId,
        goals: ['Build lunar module'],
        status: 'running',
        project: '/srv/agent-projects/moon',
        started_at: sess?.started_at,
        ended_at: null,
      });

      store.close();
    });

    it('listQueue(limit) trả mục MỚI NHẤT trước (ORDER BY id DESC LIMIT ?); test 5 mục, limit 2 → 2 mục id lớn nhất', () => {
      const dbPath = createTempDbFile();
      const store = openStore(dbPath);

      const id1 = store.enqueue('dev', 'item 1');
      const id2 = store.enqueue('qc', 'item 2');
      const id3 = store.enqueue('pm', 'item 3');
      const id4 = store.enqueue('dev', 'item 4');
      const id5 = store.enqueue('qc', 'item 5');

      const items = store.listQueue(2);
      expect(items).toHaveLength(2);
      expect(items[0].id).toBe(id5);
      expect(items[1].id).toBe(id4);
      expect(items[0].text).toBe('item 5');
      expect(items[1].text).toBe('item 4');

      store.close();
    });

    it('cách ly session: 2 session, listTaskStates/listTurns/listHandoffFailures của session 1 không chứa dữ liệu session 2', () => {
      const dbPath = createTempDbFile();
      const store = openStore(dbPath);

      const s1 = store.createSession(['Goal S1']);
      const s2 = store.createSession(['Goal S2']);

      // Session 1 data
      store.setTaskState(s1, 'T-001', 'in_dev', 0);
      const t1 = store.startTurn(s1, 'dev', 'jacky', 'T-001');
      store.endTurn(t1, 'ok');
      store.recordHandoffFailure(s1, 'T-001', 's1 error');

      // Session 2 data
      store.setTaskState(s2, 'T-002', 'awaiting_qc', 1);
      const t2 = store.startTurn(s2, 'qc', 'jenny', 'T-002');
      store.endTurn(t2, 'rejected', 's2 reject');
      store.recordHandoffFailure(s2, 'T-002', 's2 failure');

      // Session 1 queries must not contain session 2 data
      const states1 = store.listTaskStates(s1);
      expect(states1).toHaveLength(1);
      expect(states1[0].task_id).toBe('T-001');
      expect(states1.some((st) => st.task_id === 'T-002')).toBe(false);

      const turns1 = store.listTurns(s1);
      expect(turns1).toHaveLength(1);
      expect(turns1[0].id).toBe(t1);
      expect(turns1[0].task_id).toBe('T-001');
      expect(turns1.some((tr) => tr.id === t2 || tr.task_id === 'T-002')).toBe(false);

      const failures1 = store.listHandoffFailures(s1);
      expect(failures1).toHaveLength(1);
      expect(failures1[0].task_id).toBe('T-001');
      expect(failures1[0].reason).toBe('s1 error');
      expect(failures1.some((f) => f.task_id === 'T-002' || f.reason === 's2 failure')).toBe(false);

      // Session 2 queries must not contain session 1 data
      const states2 = store.listTaskStates(s2);
      expect(states2).toHaveLength(1);
      expect(states2[0].task_id).toBe('T-002');
      expect(states2.some((st) => st.task_id === 'T-001')).toBe(false);

      const turns2 = store.listTurns(s2);
      expect(turns2).toHaveLength(1);
      expect(turns2[0].id).toBe(t2);
      expect(turns2[0].task_id).toBe('T-002');
      expect(turns2.some((tr) => tr.id === t1 || tr.task_id === 'T-001')).toBe(false);

      const failures2 = store.listHandoffFailures(s2);
      expect(failures2).toHaveLength(1);
      expect(failures2[0].task_id).toBe('T-002');
      expect(failures2[0].reason).toBe('s2 failure');
      expect(failures2.some((f) => f.task_id === 'T-001' || f.reason === 's1 error')).toBe(false);

      store.close();
    });

    it('manages settings with getSetting and setSetting (table settings)', () => {
      const store = openStore(':memory:');
      expect(store.getSetting('auto_approve')).toBeNull();
      expect(store.getSetting('nonexistent')).toBeNull();

      store.setSetting('auto_approve', 'true');
      expect(store.getSetting('auto_approve')).toBe('true');

      store.setSetting('auto_approve', 'false');
      expect(store.getSetting('auto_approve')).toBe('false');

      store.setSetting('custom_key', 'some_value');
      expect(store.getSetting('custom_key')).toBe('some_value');
      store.close();
    });

    it('manages session tasks with setSessionTasks and getSessionTasks (table session_tasks)', () => {
      const store = openStore(':memory:');
      const s1 = store.createSession(['Goal 1']);
      const s2 = store.createSession(['Goal 2']);

      expect(store.getSessionTasks(s1)).toEqual([]);
      expect(store.getSessionTasks(s2)).toEqual([]);

      store.setSessionTasks(s1, ['T-001', 'T-002']);
      store.setSessionTasks(s2, ['T-003']);

      expect(store.getSessionTasks(s1)).toEqual(['T-001', 'T-002']);
      expect(store.getSessionTasks(s2)).toEqual(['T-003']);

      store.close();
    });

    it('manages notes with createNote, getNote, setNoteSession, setNoteStatus, setNoteImage, listNotes, getNotesBySession', () => {
      const store = openStore(':memory:');
      const id1 = store.createNote('/srv/agent-projects/proj-a', 'Ghi chú 1', 'N-1.png');
      expect(id1).toBe(1);

      const note1 = store.getNote(id1);
      expect(note1).toEqual({
        id: 1,
        project: '/srv/agent-projects/proj-a',
        text: 'Ghi chú 1',
        image: 'N-1.png',
        status: 'open',
        created_at: expect.any(String),
        session_id: null,
      });

      const id2 = store.createNote('/srv/agent-projects/proj-a', 'Ghi chú 2');
      expect(id2).toBe(2);

      store.setNoteImage(id2, 'N-2.jpg');
      expect(store.getNote(id2)?.image).toBe('N-2.jpg');

      store.setNoteSession(id1, 101);
      expect(store.getNote(id1)?.session_id).toBe(101);

      store.setNoteStatus(id1, 'done');
      expect(store.getNote(id1)?.status).toBe('done');

      // Notes by session
      expect(store.getNotesBySession(101)).toHaveLength(1);
      expect(store.getNotesBySession(101)[0].id).toBe(1);
      expect(store.getNotesBySession(999)).toHaveLength(0);

      // List notes by project
      const listA = store.listNotes('/srv/agent-projects/proj-a');
      expect(listA).toHaveLength(2);
      expect(listA[0].id).toBe(2); // newest first
      expect(listA[1].id).toBe(1);

      // deleteNote
      store.deleteNote(id1);
      expect(store.getNote(id1)).toBeNull();
      expect(store.listNotes('/srv/agent-projects/proj-a')).toHaveLength(1);

      store.close();
    });
  });
});
