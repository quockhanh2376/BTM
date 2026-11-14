import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { buildSnapshot } from '../src/server/snapshot.ts';
import { archiveGoalAction, restoreGoalAction, purgeGoalAction } from '../src/server/goal-trash.ts';
import { tmpRepo } from './helpers.ts';

function setup() {
  const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n', 'README.md': 'x' });
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  const base = loadConfig('btm.config.yaml');
  const cfg = { ...base, host: { ...base.host, data_dir: mkdtempSync(join(tmpdir(), 'btm-trash-')) } } as Config;
  const g1 = store.createGoal(repo, 'Game');
  const g2 = store.createGoal(repo, 'Finn e tra loi');
  for (const g of [g1, g2]) execFileSync('git', ['branch', g.branch], { cwd: repo });
  const s1 = store.createSession(['1'], repo);
  store.setSessionStatus(s1, 'needs_owner');
  const s2 = store.createSession([2], repo as any);
  store.setSessionStatus(s2, 'needs_owner');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  return { repo, store, cfg, g1, g2, s1, s2, head };
}

describe('Thùng rác goal (2026-11-14)', () => {
  it('vào thùng rác: ẩn khỏi bảng, phiên đang dừng của goal kết thúc, dashboard lấy phiên của goal còn lại', () => {
    const t = setup();
    expect(archiveGoalAction(t.store, t.repo, 2)).toEqual({ ok: true });
    expect(t.store.getSession(t.s2)?.status).toBe('refused');
    expect(t.store.getSession(t.s1)?.status).toBe('needs_owner');
    const snap = buildSnapshot(t.store, t.cfg);
    expect(snap.goals.map((g) => g.n)).toEqual([1]);
    expect(snap.session?.id).toBe(t.s1);
    expect(snap.trash).toBe(1);
    expect(t.store.getLatestSession('needs_owner', t.repo)?.id).toBe(t.s1);
  });

  it('khôi phục: goal hiện lại và có phiên chờ để Resume', () => {
    const t = setup();
    archiveGoalAction(t.store, t.repo, 2);
    const r = restoreGoalAction(t.store, t.repo, 2);
    expect(r.ok).toBe(true);
    expect(t.store.getGoal(t.repo, 2)?.archived_at).toBeNull();
    expect(t.store.getSession((r as any).sessionId)?.status).toBe('needs_owner');
  });

  it('xoá hẳn: phải ở thùng rác trước; sao lưu goal.json + branch.bundle; xoá DB + nhánh; main và G1 nguyên; số goal không dùng lại', () => {
    const t = setup();
    expect(purgeGoalAction(t.store, t.cfg, t.repo, 2)).toMatchObject({ ok: false, status: 409 });
    archiveGoalAction(t.store, t.repo, 2);
    const r = purgeGoalAction(t.store, t.cfg, t.repo, 2) as any;
    expect(r.ok).toBe(true);
    expect(existsSync(join(r.backup, 'branch.bundle'))).toBe(true);
    expect(JSON.parse(readFileSync(join(r.backup, 'goal.json'), 'utf8')).goal.n).toBe(2);
    expect(t.store.getGoal(t.repo, 2)).toBeNull();
    expect(t.store.getSession(t.s2)).toBeNull();
    const branches = execFileSync('git', ['branch', '--list'], { cwd: t.repo, encoding: 'utf8' });
    expect(branches).toContain(t.g1.branch);
    expect(branches).not.toContain(t.g2.branch);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: t.repo, encoding: 'utf8' }).trim()).toBe(t.head);
    expect(t.store.createGoal(t.repo, 'next').n).toBe(3);
  });

  it('goal đã merge: chỉ được nằm trong thùng rác, không xoá hẳn', () => {
    const t = setup();
    t.store.setGoalState(t.repo, 1, 'merged', 'owner');
    archiveGoalAction(t.store, t.repo, 1);
    expect(purgeGoalAction(t.store, t.cfg, t.repo, 1)).toMatchObject({ ok: false, status: 409 });
    expect(t.store.getGoal(t.repo, 1)).not.toBeNull();
  });
});
