import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import {
  lastLogLine,
  buildSnapshot,
  type Snapshot,
  type SeatCard,
} from '../src/server/snapshot.ts';

describe('Snapshot and Log Tail', () => {
  let tmpDir: string;
  let store: Store;
  let cfg: Config;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'btm-snap-test-'));
    store = openStore(':memory:');
    cfg = loadConfig('btm.config.yaml');
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('lastLogLine', () => {
    it('returns empty string when file is null or undefined', () => {
      expect(lastLogLine(null)).toBe('');
      expect(lastLogLine(undefined as unknown as string)).toBe('');
    });

    it('returns empty string when file does not exist', () => {
      expect(lastLogLine(join(tmpDir, 'nonexistent.log'))).toBe('');
    });

    it('returns empty string when file is empty', () => {
      const file = join(tmpDir, 'empty.log');
      writeFileSync(file, '');
      expect(lastLogLine(file)).toBe('');
    });

    it('returns empty string when file contains only whitespace and newlines', () => {
      const file = join(tmpDir, 'spaces.log');
      writeFileSync(file, '   \n\n\t  \r\n  ');
      expect(lastLogLine(file)).toBe('');
    });

    it('strips ANSI escape codes: \\x1b[32mOK\\x1b[0m\\n\\n -> OK', () => {
      const file = join(tmpDir, 'ansi.log');
      writeFileSync(file, '\x1b[32mOK\x1b[0m\n\n');
      expect(lastLogLine(file)).toBe('OK');
    });

    it('strips ANSI escape codes including CSI and OSC (BEL and ESC \\): \\x1b]0;secret-title\\x07OK -> OK', () => {
      const fileBel = join(tmpDir, 'osc-bel.log');
      writeFileSync(fileBel, '\x1b]0;secret-title\x07OK\n');
      expect(lastLogLine(fileBel)).toBe('OK');

      const fileSt = join(tmpDir, 'osc-st.log');
      writeFileSync(fileSt, '\x1b]0;secret-title\x1b\\OK\n');
      expect(lastLogLine(fileSt)).toBe('OK');
    });

    it('reads backward when trailing lines are empty: "OK" followed by 100 KB empty lines -> "OK"', () => {
      const file = join(tmpDir, 'empty-tail.log');
      writeFileSync(file, 'OK\n' + '\n'.repeat(100 * 1024));
      expect(lastLogLine(file)).toBe('OK');
    });

    it('discards partial line at chunk boundary and reads backward to recover full line', () => {
      const file = join(tmpDir, 'partial-boundary.log');
      // Full line of 19 bytes followed by 65532 bytes of newlines -> total 65551 bytes
      // Last 64 KB (65536 bytes) starts at offset 15, which slices into 'SUFFIX'
      const content = 'LONG_PREFIX_SUFFIX\n' + '\n'.repeat(64 * 1024 - 4);
      writeFileSync(file, content);
      expect(lastLogLine(file)).toBe('LONG_PREFIX_SUFFIX');
    });

    it('truncates line to maximum 200 characters: 1000 chars -> 200 chars', () => {
      const file = join(tmpDir, 'long.log');
      const longLine = 'A'.repeat(1000);
      writeFileSync(file, longLine);
      const res = lastLogLine(file);
      expect(res.length).toBe(200);
      expect(res).toBe('A'.repeat(200));
    });

    it('returns the last non-empty line when file has multiple lines and trailing newlines', () => {
      const file = join(tmpDir, 'multiline.log');
      writeFileSync(file, 'Line 1\nLine 2\n\x1b[34mFinal output line\x1b[0m\n\n\n');
      expect(lastLogLine(file)).toBe('Final output line');
    });

    it('handles directory path or unreadable file safely without throwing', () => {
      expect(lastLogLine(tmpDir)).toBe('');
    });
  });

  describe('buildSnapshot', () => {
    it('returns project: null, session: null, 3 card idle when no active project', () => {
      const snap = buildSnapshot(store, cfg);

      expect(snap.project).toBeNull();
      expect(snap.session).toBeNull();
      expect(snap.holder).toBeNull();
      expect(snap.tasks).toEqual([]);
      expect(snap.log).toEqual([]);
      expect(snap.queue).toEqual([]);

      expect(snap.seats).toHaveLength(3);
      expect(snap.seats[0]).toEqual({
        seat: 'pm',
        agent: cfg.seats.pm,
        tool: cfg.agents[cfg.seats.pm].tool,
        status: 'idle',
        taskId: null,
        since: null,
        turns: 0,
        lastLine: '',
        energy: '—',
        login: '—',
      });
      expect(snap.seats[1]).toEqual({
        seat: 'dev',
        agent: cfg.seats.dev,
        tool: cfg.agents[cfg.seats.dev].tool,
        status: 'idle',
        taskId: null,
        since: null,
        turns: 0,
        lastLine: '',
        energy: '—',
        login: '—',
      });
      expect(snap.seats[2]).toEqual({
        seat: 'qc',
        agent: cfg.seats.qc,
        tool: cfg.agents[cfg.seats.qc].tool,
        status: 'idle',
        taskId: null,
        since: null,
        turns: 0,
        lastLine: '',
        energy: '—',
        login: '—',
      });
    });

    it('returns project set and 3 cards idle when active project exists but no session', () => {
      const projDir = join(tmpDir, 'proj');
      mkdirSync(projDir, { recursive: true });
      store.setActiveProject(projDir);

      const snap = buildSnapshot(store, cfg);
      expect(snap.project).toBe(projDir);
      expect(snap.session).toBeNull();
      expect(snap.holder).toBeNull();
      expect(snap.seats.map((s) => s.status)).toEqual(['idle', 'idle', 'idle']);
    });

    it('builds snapshot with 1 session, dev turn running -> holder===dev, dev running, pm waiting', () => {
      const projDir = join(tmpDir, 'my-proj');
      mkdirSync(join(projDir, 'team', 'tasks'), { recursive: true });
      store.setActiveProject(projDir);

      const sessId = store.createSession(['Goal 1', 'Goal 2'], projDir);

      // Turn 1: PM ran and completed
      const pmLog = join(tmpDir, 'pm-turn-1.log');
      writeFileSync(pmLog, 'PM finished planning\nAll tasks created\n');
      const t1 = store.startTurn(sessId, 'pm', cfg.seats.pm, null);
      store.setTurnLog(t1, pmLog);
      store.endTurn(t1, 'ok');

      // Turn 2: Dev started and is currently running (ended_at is null)
      const devLog = join(tmpDir, 'dev-turn-2.log');
      writeFileSync(devLog, '\x1b[32mCompiling TypeScript files...\x1b[0m\n');
      const t2 = store.startTurn(sessId, 'dev', cfg.seats.dev, 'T-001');
      store.setTurnLog(t2, devLog);

      const snap = buildSnapshot(store, cfg);

      expect(snap.project).toBe(projDir);
      expect(snap.session).toEqual({
        id: sessId,
        status: 'running',
        goals: ['Goal 1', 'Goal 2'],
        turnsUsed: 2,
        maxTurns: cfg.session.max_turns,
      });

      expect(snap.holder).toBe('dev');

      const pmCard = snap.seats.find((s) => s.seat === 'pm');
      const devCard = snap.seats.find((s) => s.seat === 'dev');
      const qcCard = snap.seats.find((s) => s.seat === 'qc');

      expect(devCard?.status).toBe('running');
      expect(devCard?.taskId).toBe('T-001');
      expect(devCard?.since).toBeTypeOf('string');
      expect(devCard?.turns).toBe(1);
      expect(devCard?.lastLine).toBe('Compiling TypeScript files...');

      expect(pmCard?.status).toBe('waiting');
      expect(pmCard?.turns).toBe(1);
      expect(pmCard?.lastLine).toBe('All tasks created');

      expect(qcCard?.status).toBe('waiting');
      expect(qcCard?.turns).toBe(0);
      expect(qcCard?.lastLine).toBe('');
    });

    it('loads task cards and goals, gracefully falling back to empty string on missing file', () => {
      const projDir = join(tmpDir, 'task-proj');
      const tasksDir = join(projDir, 'team', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      store.setActiveProject(projDir);

      // Write valid task card for T-001
      const cardContent = `---
id: T-001
goal: Add authentication flow
scope:
  - src/auth.ts
acceptance:
  - Tokens are generated
done_when: all tests pass
---
# T-001
`;
      writeFileSync(join(tasksDir, 'T-001.md'), cardContent);

      const sessId = store.createSession(['Goal Auth'], projDir);
      store.setTaskState(sessId, 'T-001', 'in_dev', 0);
      store.setTaskState(sessId, 'T-002', 'pending', 1);

      const snap = buildSnapshot(store, cfg);

      expect(snap.tasks).toEqual([
        { id: 'T-001', goal: 'Add authentication flow', state: 'in_dev', fixRounds: 0 },
        { id: 'T-002', goal: '', state: 'pending', fixRounds: 1 },
      ]);
    });

    it('does not leak goal when task file is symlinked outside or task id contains "../"', () => {
      const projDir = join(tmpDir, 'symlink-proj');
      const tasksDir = join(projDir, 'team', 'tasks');
      mkdirSync(tasksDir, { recursive: true });
      store.setActiveProject(projDir);

      const outsideDir = mkdtempSync(join(tmpdir(), 'btm-outside-'));
      const secretCard = `---
id: T-999
goal: Secret Outside Goal
scope:
  - secret.txt
acceptance:
  - secret
done_when: secret
---
# Secret
`;
      const outsideFile = join(outsideDir, 'secret.md');
      writeFileSync(outsideFile, secretCard);

      // Symlink outside file into team/tasks/T-002.md
      symlinkSync(outsideFile, join(tasksDir, 'T-002.md'));

      // Put a secret card at team/secret.md to test '../secret'
      writeFileSync(join(projDir, 'team', 'secret.md'), secretCard);

      const sessId = store.createSession(['Goal Test'], projDir);
      store.setTaskState(sessId, 'T-002', 'pending', 0);
      store.setTaskState(sessId, '../secret', 'pending', 0);

      const snap = buildSnapshot(store, cfg);

      const t002 = snap.tasks.find((t) => t.id === 'T-002');
      const tDotDot = snap.tasks.find((t) => t.id === '../secret');

      expect(t002?.goal).toBe('');
      expect(tDotDot?.goal).toBe('');

      rmSync(outsideDir, { recursive: true, force: true });
    });

    it('limits snapshot log to exactly 50 newest events when there are > 50 events', () => {
      const projDir = join(tmpDir, 'many-events-proj');
      mkdirSync(projDir, { recursive: true });
      store.setActiveProject(projDir);

      const sessId = store.createSession(['Many events'], projDir);

      vi.useFakeTimers();
      try {
        // Create 30 turns: each turn generates start and end log entries (60 entries)
        for (let i = 1; i <= 30; i++) {
          vi.setSystemTime(new Date(1700000000000 + i * 2000));
          const t = store.startTurn(sessId, 'dev', cfg.seats.dev, `T-${String(i).padStart(3, '0')}`);
          vi.setSystemTime(new Date(1700000000000 + i * 2000 + 1000));
          store.endTurn(t, 'ok');
        }
      } finally {
        vi.useRealTimers();
      }

      const snap = buildSnapshot(store, cfg);

      expect(snap.log.length).toBe(50);
      // Verify newest first
      for (let i = 1; i < snap.log.length; i++) {
        expect(snap.log[i - 1].at >= snap.log[i].at).toBe(true);
      }
      // Oldest turn T-001 should not be in the newest 50 events
      expect(snap.log.some((l) => l.text.includes('bắt đầu T-001'))).toBe(false);
      // Newest turn T-030 should be in the newest 50 events
      expect(snap.log.some((l) => l.text.includes('bắt đầu T-030'))).toBe(true);
    });

    it('aggregates log entries: turn start/end, handoff failures, session status (max 50, newest first)', () => {
      const projDir = join(tmpDir, 'log-proj');
      mkdirSync(projDir, { recursive: true });
      store.setActiveProject(projDir);

      const sessId = store.createSession(['Goal Log'], projDir);

      // PM turn ok
      const t1 = store.startTurn(sessId, 'pm', 'elon', null);
      store.endTurn(t1, 'ok');

      // Dev turn rejected
      const t2 = store.startTurn(sessId, 'dev', 'jacky', 'T-001');
      store.recordHandoffFailure(sessId, 'T-001', 'out_of_scope: modified outside.txt');
      store.endTurn(t2, 'rejected', 'diff_empty');

      // QC turn ok
      const t3 = store.startTurn(sessId, 'qc', 'jenny', 'T-001');
      store.endTurn(t3, 'ok');

      const snap = buildSnapshot(store, cfg);

      expect(snap.log.length).toBeGreaterThanOrEqual(5);

      // Check order: newest first
      for (let i = 1; i < snap.log.length; i++) {
        expect(snap.log[i - 1].at >= snap.log[i].at).toBe(true);
      }

      // Verify specific log events exist
      expect(
        snap.log.some((l) => l.who === 'jacky' && l.text.includes('bắt đầu T-001'))
      ).toBe(true);

      expect(
        snap.log.some((l) => l.who === 'jenny' && l.text.includes('ok'))
      ).toBe(true);

      expect(
        snap.log.some(
          (l) => l.who === 'gate' && l.text.includes('out_of_scope: modified outside.txt')
        )
      ).toBe(true);

      expect(
        snap.log.some((l) => l.who === 'session')
      ).toBe(true);
    });

    it('includes queue items in snapshot.queue', () => {
      const q1 = store.enqueue('dev', 'Fix syntax error in index.ts');
      const q2 = store.enqueue('qc', 'Verify test coverage');

      const snap = buildSnapshot(store, cfg);
      expect(snap.queue.length).toBe(2);
      expect(snap.queue[0].id).toBe(q2); // newest first from listQueue
      expect(snap.queue[0].to).toBe('qc');
      expect(snap.queue[1].id).toBe(q1);
      expect(snap.queue[1].to).toBe('dev');
    });

    it('sets all seats to idle when session is completed', () => {
      const projDir = join(tmpDir, 'done-proj');
      mkdirSync(projDir, { recursive: true });
      store.setActiveProject(projDir);

      const sessId = store.createSession(['Goal Complete'], projDir);
      const t1 = store.startTurn(sessId, 'pm', cfg.seats.pm, null);
      store.endTurn(t1, 'ok');
      store.setSessionStatus(sessId, 'done');

      const snap = buildSnapshot(store, cfg);
      expect(snap.session?.status).toBe('done');
      expect(snap.holder).toBeNull();
      expect(snap.seats.map((s) => s.status)).toEqual(['idle', 'idle', 'idle']);
    });

    it('P2-T8 B: snapshot includes settings: { autoApprove: boolean }', () => {
      // 1. Without active project or session, default from cfg (!require_task_approval)
      cfg.session.require_task_approval = true;
      const snap1 = buildSnapshot(store, cfg);
      expect(snap1.settings).toEqual({ autoApprove: false });

      cfg.session.require_task_approval = false;
      const snap2 = buildSnapshot(store, cfg);
      expect(snap2.settings).toEqual({ autoApprove: true });

      // 2. Overridden by store.setSetting('auto_approve', 'true')
      store.setSetting('auto_approve', 'true');
      const snap3 = buildSnapshot(store, cfg);
      expect(snap3.settings).toEqual({ autoApprove: true });

      // 3. Overridden by store.setSetting('auto_approve', 'false')
      store.setSetting('auto_approve', 'false');
      const snap4 = buildSnapshot(store, cfg);
      expect(snap4.settings).toEqual({ autoApprove: false });
    });

    it('includes members from cfg.agents and notes with reports', () => {
      const projDir = join(tmpDir, 'notes-proj');
      mkdirSync(join(projDir, 'team', 'tasks'), { recursive: true });
      mkdirSync(join(projDir, 'team', 'reports'), { recursive: true });
      store.setActiveProject(projDir);

      // Create card T-001 with note N-1
      writeFileSync(
        join(projDir, 'team', 'tasks', 'T-001.md'),
        `---
id: T-001
goal: Goal 1
scope: [src/]
acceptance: [ok]
done_when: done
note: N-1
---
`
      );

      // Create report for T-001
      writeFileSync(
        join(projDir, 'team', 'reports', 'T-001-dev.md'),
        '## Bug\n- Bug 1\n## Cần sửa\n- Fix 1\nOK'
      );

      // Create note 1
      const noteId = store.createNote(projDir, 'Ghi chú quan trọng', 'N-1.png');

      const snap = buildSnapshot(store, cfg);
      expect(snap.members).toEqual(Object.keys(cfg.agents));
      expect(snap.notes).toHaveLength(1);
      expect(snap.notes[0]).toEqual({
        id: noteId,
        text: 'Ghi chú quan trọng',
        image: 'N-1.png',
        status: 'open',
        at: expect.any(String),
        report: '## Bug\n- Bug 1\n## Cần sửa\n- Fix 1\nOK',
      });
    });
  });
});
