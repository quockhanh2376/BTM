import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore, type Store } from '../src/store/db.ts';

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
  });
});
