import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openStore } from '../src/store/db.ts';
import { buildTicketTrace, readTurnLog } from '../src/server/trace.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'btm-trace-'));
  const dbFile = join(dir, 'btm.db');
  const store = openStore(dbFile);
  const raw = new Database(dbFile);
  const project = '/srv/p';
  store.setActiveProject(project);
  const t = { goal: 'G1', of: 1, number: 1, type: 'feat', size: 'S', scope: ['a.js'], acceptance: ['x'], done_when: 'x', title: 'A' } as any;
  store.upsertTicket(project, { ...t, id: 'GT-0001' });
  const sid = store.createSession(['1'], project);
  const turn = (seat: string, agent: string, a: string, b: string | null, log: string | null) => {
    const id = store.startTurn(sid, seat as any, agent, 'GT-0001');
    raw.prepare('UPDATE turns SET started_at = ?, ended_at = ?, result = ?, log_file = ? WHERE id = ?').run(a, b, b ? 'ok' : null, log, id);
    return id;
  };
  return { dir, store, raw, project, sid, turn };
}

describe('Truy vết ticket (2026-11-14)', () => {
  it('trộn đổi trạng thái + lượt theo giờ, tổng theo ghế, số lần trả về', () => {
    const s = setup();
    s.turn('dev', 'jenny', '2026-11-14T01:00:00Z', '2026-11-14T01:10:00Z', null);
    s.store.setTicketState(s.project, 'GT-0001', 'returned', 'elon', 'qc fail', 1);
    s.turn('qc', 'elon', '2026-11-14T01:11:00Z', '2026-11-14T01:14:00Z', null);
    s.turn('dev', 'mb', '2026-11-14T01:20:00Z', '2026-11-14T01:25:00Z', null);
    const { events, totals } = buildTicketTrace(s.store, s.project, 'GT-0001');
    expect(totals).toMatchObject({ turns: 3, agentMs: 18 * 60000, bySeat: { dev: 15 * 60000, qc: 3 * 60000 }, fixRounds: 1, returns: 1 });
    const turns = events.filter((e) => e.kind === 'turn');
    expect(turns.map((e) => (e as any).agent)).toEqual(['jenny', 'elon', 'mb']);
    for (let i = 1; i < events.length; i++) expect(Date.parse(events[i]!.at)).toBeGreaterThanOrEqual(Date.parse(events[i - 1]!.at));
  });

  it('ticket chưa có lượt: totals 0; lượt đang chạy tính tới hiện tại', () => {
    const s = setup();
    expect(buildTicketTrace(s.store, s.project, 'GT-0001').totals).toMatchObject({ turns: 0, agentMs: 0, returns: 0 });
    s.turn('dev', 'jenny', '2026-11-14T01:00:00Z', null, null);
    const tr = buildTicketTrace(s.store, s.project, 'GT-0001', Date.parse('2026-11-14T01:02:00Z'));
    expect(tr.totals.agentMs).toBe(120000);
  });

  it('log: 300 dòng cuối; ngoài logDir / project khác / không có → null', () => {
    const s = setup();
    const logDir = join(s.dir, 'logs');
    const inside = join(logDir, 'turn-1.log');
    mkdirSync(logDir);
    writeFileSync(inside, Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const outside = join(s.dir, 'secret.txt');
    writeFileSync(outside, 'x');
    const a = s.turn('dev', 'jenny', '2026-11-14T01:00:00Z', '2026-11-14T01:01:00Z', inside);
    const b = s.turn('dev', 'jenny', '2026-11-14T01:00:00Z', '2026-11-14T01:01:00Z', outside);
    const c = s.turn('dev', 'jenny', '2026-11-14T01:00:00Z', '2026-11-14T01:01:00Z', null);
    const log = readTurnLog(s.store, s.project, logDir, a)!;
    expect(log.split('\n')).toHaveLength(300);
    expect(log.endsWith('line 399')).toBe(true);
    expect(readTurnLog(s.store, s.project, logDir, b)).toBeNull();
    expect(readTurnLog(s.store, s.project, logDir, c)).toBeNull();
    expect(readTurnLog(s.store, '/srv/other', logDir, a)).toBeNull();
    expect(readTurnLog(s.store, s.project, logDir, 9999)).toBeNull();
  });
});
