import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.ts';
import { retryTicket } from '../src/server/ticket-retry.ts';

function setup() {
  const repo = '/tmp/proj-retry';
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  const g = store.createGoal(repo, 'Game');
  const base = { goal: 'G1', of: 3, type: 'feat', size: 'S', scope: ['a.js'], acceptance: ['x'], done_when: 'x' } as any;
  for (const [i, id] of ['GT-0005', 'GT-0006', 'GT-0007'].entries()) store.upsertTicket(repo, { ...base, id, number: i + 1, title: id });
  store.setTicketState(repo, 'GT-0005', 'failed', 'jenny', 'gate bad_report', 3, 'abc');
  store.setTicketState(repo, 'GT-0006', 'blocked', 'core', 'depends on failed GT-0005');
  store.setTicketState(repo, 'GT-0007', 'blocked', 'jenny', 'Dev reported BLOCKED');
  const sid = store.createSession(['1'], repo);
  store.setSessionStatus(sid, 'done');
  return { repo, store, g, sid };
}

describe('Làm lại ticket (2026-11-14)', () => {
  it('failed → returned với vòng sửa mới; ticket bị core chặn dây chuyền → pending; ticket Dev tự BLOCKED giữ nguyên; có phiên chờ', () => {
    const t = setup();
    const r = retryTicket(t.store, t.repo, 'GT-0005') as any;
    expect(r.ok).toBe(true);
    expect(r.reopened).toEqual(['GT-0005', 'GT-0006']);
    expect(t.store.getTicketState(t.repo, 'GT-0005')).toMatchObject({ state: 'returned', fix_rounds: 0, base_sha: 'abc' });
    expect(t.store.getTicketState(t.repo, 'GT-0006')?.state).toBe('pending');
    expect(t.store.getTicketState(t.repo, 'GT-0007')?.state).toBe('blocked');
    expect(r.sessionId).not.toBe(t.sid);
    expect(t.store.getSession(r.sessionId)).toMatchObject({ status: 'needs_owner', goals: ['1'] });
  });

  it('ticket không failed/blocked, goal đã merge hoặc ở thùng rác → từ chối', () => {
    const t = setup();
    t.store.setTicketState(t.repo, 'GT-0005', 'passed', 'qc', 'ok');
    expect(retryTicket(t.store, t.repo, 'GT-0005')).toMatchObject({ ok: false, status: 409 });
    t.store.setGoalState(t.repo, 1, 'merged', 'owner');
    expect(retryTicket(t.store, t.repo, 'GT-0007')).toMatchObject({ ok: false, status: 409 });
    expect(retryTicket(t.store, t.repo, 'GT-9999')).toMatchObject({ ok: false, status: 404 });
  });

  it('đã có phiên dừng của goal → dùng lại phiên đó (không tạo thêm)', () => {
    const t = setup();
    const paused = t.store.createSession(['1'], t.repo);
    t.store.setSessionStatus(paused, 'needs_owner');
    expect((retryTicket(t.store, t.repo, 'GT-0007') as any).sessionId).toBe(paused);
  });
});
