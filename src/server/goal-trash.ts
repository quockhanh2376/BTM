import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import { git } from '../git.ts';
import { readProjectKey } from '../ticket/goal.ts';

// Thùng rác goal (anh Zon 2026-11-14). Spec: docs/superpowers/specs/2026-11-14-goal-trash-design.md
// Vào thùng rác = ẩn, không mất gì. Xoá hẳn = sao lưu (goal.json + branch.bundle) rồi mới xoá DB + nhánh goal.
// Không bao giờ đụng main, nhánh khác hay GitHub.

export type TrashResult = { ok: true; backup?: string; sessionId?: number } | { ok: false; status: number; error: string };

const DONE = new Set(['approved', 'merged']);

export function archiveGoalAction(store: Store, project: string, n: number): TrashResult {
  const g = store.getGoal(project, n);
  if (!g) return { ok: false, status: 404, error: 'Unknown goal' };
  if (g.archived_at) return { ok: false, status: 409, error: 'Goal already in Trash' };
  store.archiveGoal(project, n);
  return { ok: true };
}

export function restoreGoalAction(store: Store, project: string, n: number): TrashResult {
  const g = store.getGoal(project, n);
  if (!g) return { ok: false, status: 404, error: 'Unknown goal' };
  if (!g.archived_at) return { ok: false, status: 409, error: 'Goal is not in Trash' };
  store.restoreGoal(project, n);
  if (DONE.has(g.state)) return { ok: true };
  // Goal chưa xong: mở sẵn một phiên chờ để anh bấm Resume là chạy tiếp (như "trả ticket về Dev").
  const sessionId = store.createSession([String(n)], project);
  store.setSessionStatus(sessionId, 'needs_owner');
  return { ok: true, sessionId };
}

export function purgeGoalAction(store: Store, cfg: Config, project: string, n: number, now = new Date()): TrashResult {
  const g = store.getGoal(project, n);
  if (!g) return { ok: false, status: 404, error: 'Unknown goal' };
  if (!g.archived_at) return { ok: false, status: 409, error: 'Move the goal to Trash first' };
  if (DONE.has(g.state)) return { ok: false, status: 409, error: 'Goal is merged into main: it can only stay in Trash' };
  const protectedBranch = cfg.git?.protected_branch || 'main';
  if (!g.branch || g.branch === protectedBranch || !g.branch.startsWith('goal/')) {
    return { ok: false, status: 409, error: 'Refusing to delete this branch' };
  }
  let current = '';
  try { current = git(project, 'symbolic-ref', '-q', '--short', 'HEAD').trim(); } catch { /* HEAD tách rời */ }
  if (current === g.branch) return { ok: false, status: 409, error: 'The project checkout is on this goal branch' };

  let hasBranch = false;
  try { git(project, 'rev-parse', '--verify', '-q', `refs/heads/${g.branch}`); hasBranch = true; } catch { /* nhánh đã mất */ }

  const key = readProjectKey(project);
  const dir = join(cfg.host.data_dir, 'trash', key, `G${n}-${now.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'goal.json'), JSON.stringify({ project, n, exportedAt: now.toISOString(), ...store.exportGoal(project, n) }, null, 2), { mode: 0o600 });
  if (hasBranch) git(project, 'bundle', 'create', join(dir, 'branch.bundle'), `refs/heads/${g.branch}`);

  store.purgeGoal(project, n);
  if (hasBranch) git(project, 'branch', '-D', g.branch);
  return { ok: true, backup: dir };
}
