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
      expect(snap.goals).toEqual([]);
      expect(snap.log).toEqual([]);
      expect(snap.queue).toEqual([]);

      expect(snap.seats).toHaveLength(3);
      expect(snap.seats[0]).toMatchObject({
        seat: 'pm',
        agent: cfg.seats.pm,
        tool: cfg.agents[cfg.seats.pm].tool,
        status: 'idle',
        ticket: null,
        taskId: null,
        since: null,
        turns: 0,
        lastLine: '',
        energy: { status: 'unknown', windows: [], readAt: '' },
        login: { state: 'unknown', detail: 'Unknown' },
        candidates: ['elon'],
      });
      expect(snap.seats[1]).toMatchObject({
        seat: 'dev',
        agent: cfg.seats.dev,
        tool: cfg.agents[cfg.seats.dev].tool,
        status: 'idle',
        ticket: null,
        taskId: null,
        since: null,
        turns: 0,
        lastLine: '',
        energy: { status: 'unknown', windows: [], readAt: '' },
        login: { state: 'unknown', detail: 'Unknown' },
        candidates: ['jacky', 'jenny'],
      });
      expect(snap.seats[2]).toMatchObject({
        seat: 'qc',
        agent: cfg.seats.qc,
        tool: cfg.agents[cfg.seats.qc].tool,
        status: 'idle',
        ticket: null,
        taskId: null,
        since: null,
        turns: 0,
        lastLine: '',
        energy: { status: 'unknown', windows: [], readAt: '' },
        login: { state: 'unknown', detail: 'Unknown' },
        candidates: ['elon', 'jenny'],
      });
    });

    it('uses effectiveSeats and provides candidates for each seat card', () => {
      store.setSetting('seat:dev', 'jenny');
      const snap = buildSnapshot(store, cfg);
      const devCard = snap.seats.find((s) => s.seat === 'dev');
      expect(devCard?.agent).toBe('jenny');
      expect(devCard?.candidates).toEqual(['jacky', 'jenny']);

      const pmCard = snap.seats.find((s) => s.seat === 'pm');
      expect(pmCard?.candidates).toEqual(['elon']);

      const qcCard = snap.seats.find((s) => s.seat === 'qc');
      expect(qcCard?.candidates).toEqual(['elon', 'jenny']);
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
      expect(devCard?.ticket).toBe('T-001');
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

    it('P4-T9: builds goals from store and disk tickets with passed/total count and stages', () => {
      const projDir = join(tmpDir, 'ticket-proj');
      mkdirSync(join(projDir, 'team', 'tickets'), { recursive: true });
      writeFileSync(join(projDir, 'team', 'project.yaml'), 'name: Proj\nkey: PRJ\n');
      store.setActiveProject(projDir);

      // Create goal G1 in store
      store.createGoal(projDir, 'UI Dashboard');
      store.setGoalState(projDir, 1, 'in_progress', 'pm');

      // Create 2 tickets: PRJ-0001 (passed), PRJ-0002 (pending)
      writeFileSync(
        join(projDir, 'team', 'tickets', 'PRJ-0001.md'),
        `---
id: PRJ-0001
goal: G1
number: 1
of: 2
title: Ticket 1
type: feat
size: S
scope: [src/ui.ts]
acceptance: [ok]
done_when: done
from_audit: false
---
`
      );
      writeFileSync(
        join(projDir, 'team', 'tickets', 'PRJ-0002.md'),
        `---
id: PRJ-0002
goal: G1
number: 2
of: 2
title: Ticket 2
type: fix
size: M
scope: [src/fix.ts]
acceptance: [ok]
done_when: done
from_audit: false
---
`
      );

      store.upsertTicket(projDir, {
        id: 'PRJ-0001',
        goal: 'G1',
        number: 1,
        of: 2,
        title: 'Ticket 1',
        type: 'feat',
        size: 'S',
        scope: ['src/ui.ts'],
        acceptance: ['ok'],
        done_when: 'done',
        depends_on: [],
        from_audit: false,
      });
      store.setTicketState(projDir, 'PRJ-0001', 'passed', 'qc', 'passed ok');

      store.upsertTicket(projDir, {
        id: 'PRJ-0002',
        goal: 'G1',
        number: 2,
        of: 2,
        title: 'Ticket 2',
        type: 'fix',
        size: 'M',
        scope: ['src/fix.ts'],
        acceptance: ['ok'],
        done_when: 'done',
        depends_on: [],
        from_audit: false,
      });
      store.setTicketState(projDir, 'PRJ-0002', 'pending', 'pm', 'created');

      const snap = buildSnapshot(store, cfg);

      expect(snap.goals).toHaveLength(1);
      const g1 = snap.goals[0];
      expect(g1.n).toBe(1);
      expect(g1.title).toBe('UI Dashboard');
      expect(g1.state).toBe('in_progress');
      expect(g1.stage).toBe('build');
      expect(g1.passed).toBe(1);
      expect(g1.total).toBe(2);
      expect(g1.tickets).toHaveLength(2);
      expect(g1.tickets[0].id).toBe('PRJ-0001');
      expect(g1.tickets[0].state).toBe('passed');
      expect(g1.tickets[1].id).toBe('PRJ-0002');
      expect(g1.tickets[1].state).toBe('pending');
    });

    it('P4-T9: calculates goal stage across all 6 possible stages', () => {
      const projDir = join(tmpDir, 'stages-proj');
      mkdirSync(join(projDir, 'team', 'tickets'), { recursive: true });
      writeFileSync(join(projDir, 'team', 'project.yaml'), 'name: Proj\nkey: STG\n');
      store.setActiveProject(projDir);

      // 1. open -> intake
      store.createGoal(projDir, 'Intake Goal');
      store.setGoalState(projDir, 1, 'open', 'user');

      // 2. in_progress without tickets or with PM holder -> plan
      store.createGoal(projDir, 'Plan Goal');
      store.setGoalState(projDir, 2, 'in_progress', 'pm');

      // 3. in_progress with ticket in in_dev -> build
      store.createGoal(projDir, 'Build Goal');
      store.setGoalState(projDir, 3, 'in_progress', 'dev');
      store.upsertTicket(projDir, { id: 'STG-0001', goal: 'G3', number: 1, of: 1, title: 'T1', type: 'feat', size: 'S', scope: ['src/'], acceptance: ['ok'], done_when: 'done', depends_on: [], from_audit: false });
      store.setTicketState(projDir, 'STG-0001', 'in_dev', 'dev', 'working');

      // 4. in_progress with ticket awaiting_qc -> verify
      store.createGoal(projDir, 'Verify Goal');
      store.setGoalState(projDir, 4, 'in_progress', 'qc');
      store.upsertTicket(projDir, { id: 'STG-0002', goal: 'G4', number: 1, of: 1, title: 'T2', type: 'feat', size: 'S', scope: ['src/'], acceptance: ['ok'], done_when: 'done', depends_on: [], from_audit: false });
      store.setTicketState(projDir, 'STG-0002', 'awaiting_qc', 'dev', 'ready');

      // 5. qc_done with audit configured -> audit
      store.createGoal(projDir, 'Audit Goal');
      store.setGoalState(projDir, 5, 'qc_done', 'qc');

      // 6. audit_passed / approved / merged -> release
      store.createGoal(projDir, 'Release Goal');
      store.setGoalState(projDir, 6, 'audit_passed', 'kai');

      const auditCfg = { ...cfg, seats: { ...cfg.seats, audit: 'kai' } };
      const snapWithAudit = buildSnapshot(store, auditCfg);

      const findGoal = (n: number) => snapWithAudit.goals.find((g) => g.n === n);
      expect(findGoal(1)?.stage).toBe('intake');
      expect(findGoal(2)?.stage).toBe('plan');
      expect(findGoal(3)?.stage).toBe('build');
      expect(findGoal(4)?.stage).toBe('verify');
      expect(findGoal(5)?.stage).toBe('audit');
      expect(findGoal(6)?.stage).toBe('release');

      // If no audit configured, qc_done -> release
      const snapNoAudit = buildSnapshot(store, cfg);
      expect(snapNoAudit.goals.find((g) => g.n === 5)?.stage).toBe('release');
    });

    it('P4-T10 fix 1: store có goal + working tree không có project.yaml → goals vẫn hiện từ store', () => {
      const projDir = join(tmpDir, 'no-project-yaml');
      mkdirSync(projDir, { recursive: true });
      store.setActiveProject(projDir);
      store.createGoal(projDir, 'Some Goal');
      store.upsertTicket(projDir, {
        id: 'GTM-0001',
        goal: 'G1',
        number: 1,
        of: 1,
        title: 'Ticket from DB',
        type: 'feat',
        size: 'S',
        scope: ['src/'],
        acceptance: ['ok'],
        done_when: 'done',
        depends_on: [],
        from_audit: false,
      });

      const snap = buildSnapshot(store, cfg);
      expect(snap.goals).toHaveLength(1);
      expect(snap.goals[0].n).toBe(1);
      expect(snap.goals[0].title).toBe('Some Goal');
      expect(snap.goals[0].tickets).toHaveLength(1);
      expect(snap.goals[0].tickets[0].id).toBe('GTM-0001');
      expect(snap.goals[0].tickets[0].title).toBe('Ticket from DB');
    });

    it('P4-T9: includes Kai-Audit seat when seats.audit is configured', () => {
      const auditCfg = { ...cfg, seats: { ...cfg.seats, audit: 'kai' } };
      const snap = buildSnapshot(store, auditCfg);
      expect(snap.seats).toHaveLength(4);
      const auditCard = snap.seats.find((s) => s.seat === 'audit');
      expect(auditCard).toBeDefined();
      expect(auditCard?.agent).toBe('kai');
      expect(auditCard?.status).toBe('idle');
      expect(auditCard?.ticket).toBeNull();
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
      expect(snap.log.some((l) => l.text.includes('started T-001'))).toBe(false);
      // Newest turn T-030 should be in the newest 50 events
      expect(snap.log.some((l) => l.text.includes('started T-030'))).toBe(true);
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
        snap.log.some((l) => l.who === 'jacky' && l.text.includes('started T-001'))
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
      expect(snap1.settings).toEqual({ autoApprove: false, names: {}, avatars: {}, mb: { set: false, last4: '', enabled: true }, ui: { lang: 'en', theme: 'system' }, chat: { speakers: 3, livelySec: [30, 60], normalMin: [5, 8] } });

      cfg.session.require_task_approval = false;
      const snap2 = buildSnapshot(store, cfg);
      expect(snap2.settings).toEqual({ autoApprove: true, names: {}, avatars: {}, mb: { set: false, last4: '', enabled: true }, ui: { lang: 'en', theme: 'system' }, chat: { speakers: 3, livelySec: [30, 60], normalMin: [5, 8] } });

      // 2. Overridden by store.setSetting('auto_approve', 'true')
      store.setSetting('auto_approve', 'true');
      const snap3 = buildSnapshot(store, cfg);
      expect(snap3.settings).toEqual({ autoApprove: true, names: {}, avatars: {}, mb: { set: false, last4: '', enabled: true }, ui: { lang: 'en', theme: 'system' }, chat: { speakers: 3, livelySec: [30, 60], normalMin: [5, 8] } });

      // 3. Overridden by store.setSetting('auto_approve', 'false')
      store.setSetting('auto_approve', 'false');
      const snap4 = buildSnapshot(store, cfg);
      expect(snap4.settings).toEqual({ autoApprove: false, names: {}, avatars: {}, mb: { set: false, last4: '', enabled: true }, ui: { lang: 'en', theme: 'system' }, chat: { speakers: 3, livelySec: [30, 60], normalMin: [5, 8] } });
    });

    it('settings.names: tên hiển thị Worker từ setting agent_name:<agent>; rỗng = không có', () => {
      store.setSetting('agent_name:jacky', 'David');
      store.setSetting('agent_name:elon', '');
      expect(buildSnapshot(store, cfg).settings.names).toEqual({ jacky: 'David' });
    });

    it('includes members from cfg.agents and notes with reports', () => {
      const projDir = join(tmpDir, 'notes-proj');
      mkdirSync(join(projDir, 'team', 'tickets'), { recursive: true });
      mkdirSync(join(projDir, 'team', 'reports'), { recursive: true });
      writeFileSync(join(projDir, 'team', 'project.yaml'), 'name: Proj\nkey: TEST\n');
      store.setActiveProject(projDir);

      // Create ticket TEST-0001 with note N-1
      writeFileSync(
        join(projDir, 'team', 'tickets', 'TEST-0001.md'),
        `---
id: TEST-0001
goal: G1
number: 1
of: 1
title: Goal 1
type: feat
size: S
scope: [src/]
acceptance: [ok]
done_when: done
from_audit: false
note: N-1
---
`
      );

      // Create report for TEST-0001
      writeFileSync(
        join(projDir, 'team', 'reports', 'TEST-0001-dev.md'),
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

    it('P3-T4: snapshot contains real energy/login from store, accounts list, and sshHint', () => {
      store.saveEnergy({
        agent: 'jacky',
        status: 'fresh',
        windows: [
          { name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T18:00:00Z' },
          { name: 'week', remainingPercent: 60, resetsAt: '2026-11-15T00:00:00Z' },
        ],
        readAt: '2026-11-08T15:30:00Z',
        note: 'agy ok',
      });

      store.saveLogin({
        agent: 'jacky',
        state: 'ok',
        detail: 'Đã đăng nhập',
      });

      store.saveLogin({
        agent: 'elon',
        state: 'expiring',
        detail: 'Expires 12/11',
      });

      const snap = buildSnapshot(store, cfg);

      const devSeat = snap.seats.find((s) => s.seat === 'dev');
      expect(devSeat?.energy).toMatchObject({
        status: 'fresh',
        windows: [
          { name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T18:00:00Z' },
          { name: 'week', remainingPercent: 60, resetsAt: '2026-11-15T00:00:00Z' },
        ],
        readAt: '2026-11-08T15:30:00Z',
        note: 'agy ok',
      });
      expect(devSeat?.login).toEqual({
        state: 'ok',
        detail: 'Đã đăng nhập',
      });

      const pmSeat = snap.seats.find((s) => s.seat === 'pm');
      expect(pmSeat?.login).toEqual({
        state: 'expiring',
        detail: 'Expires 12/11',
      });

      expect(snap.accounts).toBeDefined();
      expect(snap.accounts.length).toBe(Object.keys(cfg.agents).length);
      const jackyAcc = snap.accounts.find((a) => a.agent === 'jacky');
      expect(jackyAcc).toMatchObject({
        agent: 'jacky',
        tool: 'antigravity-cli',
        login: { state: 'ok', detail: 'Đã đăng nhập' },
      });

      expect(snap.sshHint).toBe('admzon@100.96.250.103');
    });
  });
});

describe('P5-T5: snapshot có model/effort/user, nhãn kiêm ghế, ghế audit đổi được', () => {
  it('account có model/effort/user; seat có model + also; audit hiện khi có agent ngồi được', async () => {
    const { buildSnapshot } = await import('../src/server/snapshot.ts');
    const { openStore } = await import('../src/store/db.ts');
    const { loadConfig } = await import('../src/config.ts');
    const base = loadConfig('btm.config.yaml');
    const cfg = {
      ...base,
      host: { ...base.host, worker_prefix: 'btm-' },
      agents: { ...base.agents, elon: { ...base.agents.elon, can_sit: ['pm', 'qc', 'audit'] as any, model: 'opus' } },
      seats: { ...base.seats, audit: 'elon' },
    } as any;
    const store = openStore(':memory:');
    store.setSetting('agent_effort:jenny', 'high');
    const snap = buildSnapshot(store, cfg) as any;
    const elon = snap.accounts.find((a: any) => a.agent === 'elon');
    expect(elon).toMatchObject({ model: 'opus', effort: 'medium', user: 'btm-elon' });
    expect(snap.accounts.find((a: any) => a.agent === 'jenny').effort).toBe('high');
    const pm = snap.seats.find((s: any) => s.seat === 'pm');
    expect(pm).toMatchObject({ model: 'opus', also: ['audit'] });
    expect(snap.seats.map((s: any) => s.seat)).toContain('audit');
    expect(Array.isArray(snap.seatWarnings)).toBe(true);
    store.close();
  });
});

describe('P6-T5: cảnh báo Energy thấp, tài khoản xếp theo giới hạn chặt nhất', () => {
  it('≤20% → warn + giờ hồi của cửa sổ thấp nhất; 25% → không; tài khoản thấp nhất lên đầu, chưa rõ xuống cuối', async () => {
    const { buildSnapshot } = await import('../src/server/snapshot.ts');
    const { openStore } = await import('../src/store/db.ts');
    const { loadConfig } = await import('../src/config.ts');
    const cfg = loadConfig('btm.config.yaml');
    const store = openStore(':memory:');
    store.saveEnergy({ agent: 'jacky', status: 'fresh', readAt: '2026-11-11T10:00:00Z', windows: [
      { name: '5h', remainingPercent: 15, resetsAt: '2026-11-11T12:30:00Z' },
      { name: 'week', remainingPercent: 60, resetsAt: '2026-11-15T00:00:00Z' },
    ] } as any);
    store.saveEnergy({ agent: 'elon', status: 'fresh', readAt: '2026-11-11T10:00:00Z', windows: [
      { name: '5h', remainingPercent: 25, resetsAt: '2026-11-11T13:00:00Z' },
    ] } as any);
    const snap = buildSnapshot(store, cfg) as any;
    const dev = snap.seats.find((s: any) => s.seat === 'dev');
    expect(dev.energy).toMatchObject({ warn: true, soonestReset: '2026-11-11T12:30:00Z', minPercent: 15 });
    expect(snap.seats.find((s: any) => s.seat === 'pm').energy.warn).toBe(false);
    expect(snap.accounts.map((a: any) => a.agent)).toEqual(['jacky', 'elon', 'jenny']);
    store.close();
  });
});

describe('P6-T7: snapshot đọc .btm-status của ghế đang chạy (không cách ly)', () => {
  it('ghế running → agentStatus từ file trạng thái; ghế khác không đọc', async () => {
    const { buildSnapshot } = await import('../src/server/snapshot.ts');
    const { openStore } = await import('../src/store/db.ts');
    const { loadConfig } = await import('../src/config.ts');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const repo = mkdtempSync(join(tmpdir(), 'btm-status-'));
    writeFileSync(join(repo, '.btm-status'), 'editing src/app.ts\n');
    const cfg = loadConfig('btm.config.yaml');
    const store = openStore(':memory:');
    store.setActiveProject(repo);
    const sid = store.createSession(['G'], repo);
    store.setSessionStatus(sid, 'running');
    store.startTurn(sid, 'dev', 'jacky', 'GTM-0001');
    const snap = buildSnapshot(store, cfg) as any;
    expect(snap.seats.find((s: any) => s.seat === 'dev').agentStatus).toBe('editing src/app.ts');
    expect(snap.seats.find((s: any) => s.seat === 'qc').agentStatus).toBeNull();
    store.close();
  });
});

describe('thẻ ghế: Last run / On ticket', () => {
  it('lượt xong gần nhất + tổng thời gian trên ticket; lượt đang chạy không cộng', () => {
    const store = openStore(':memory:');
    const cfg = loadConfig('btm.config.yaml');
    const repo = '/tmp/proj-timing';
    store.setActiveProject(repo);
    const sid = store.createSession(['G'], repo);
    const t1 = store.startTurn(sid, 'dev', 'jacky', 'GT-0001');
    store.endTurn(t1, 'timeout', 'timeout');
    const t2 = store.startTurn(sid, 'dev', 'jacky', 'GT-0001');
    store.endTurn(t2, 'ok');
    const snap = buildSnapshot(store, cfg);
    const dev = snap.seats.find((x) => x.seat === 'dev')!;
    expect(dev.lastRun).toMatchObject({ task: 'GT-0001', result: 'ok' });
    expect(dev.onTask).toMatchObject({ task: 'GT-0001', runs: 2 });
    expect(dev.onTask!.totalMs).toBeGreaterThanOrEqual(0);
    const pm = snap.seats.find((x) => x.seat === 'pm')!;
    expect(pm.lastRun ?? null).toBeNull();
    expect(pm.onTask ?? null).toBeNull();
    store.close();
  });
});


import { goalTime } from '../src/server/snapshot.ts';
describe('Thời gian goal (2026-11-14)', () => {
  it('cộng thời gian lượt theo ghế, tổng = tới lúc merge, lượt đang chạy tính tới now', () => {
    const t = goalTime('2026-11-13T07:00:00Z', '2026-11-13T10:00:00Z', [
      { seat: 'dev', started_at: '2026-11-13T07:10:00Z', ended_at: '2026-11-13T08:10:00Z' },
      { seat: 'qc', started_at: '2026-11-13T08:10:00Z', ended_at: '2026-11-13T08:20:00Z' },
      { seat: 'dev', started_at: '2026-11-13T09:00:00Z', ended_at: null },
    ], Date.parse('2026-11-13T09:30:00Z'));
    expect(t.wallMs).toBe(3 * 3600_000);
    expect(t.bySeat).toEqual({ dev: 90 * 60_000, qc: 10 * 60_000 });
    expect(t.agentMs).toBe(100 * 60_000);
  });
});
