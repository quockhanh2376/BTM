import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { git } from '../git.ts';
import { wrapForWorker, type ExecFn } from './worker.ts';

function output(result: unknown): string {
  if (Buffer.isBuffer(result)) return result.toString('utf8');
  return typeof result === 'string' ? result : '';
}

function run(file: string, args: string[], exec: ExecFn): string {
  const result = exec(file, args, { stdio: 'pipe' });
  return output(result);
}

function runWorker(cfg: Config, project: string, argv: string[], exec: ExecFn): string {
  const wrapped = wrapForWorker(cfg, argv, project);
  return run(wrapped[0]!, wrapped.slice(1), exec);
}

export function trustedRepoPath(cfg: Config, project: string): string {
  const root = cfg.host.trusted_root;
  if (!root) throw new Error('host.trusted_root is required');
  return join(resolve(root), `${basename(resolve(project))}.git`);
}

export function ensureTrustedRepo(cfg: Config, project: string): string {
  const trusted = trustedRepoPath(cfg, project);
  if (!existsSync(trusted)) {
    mkdirSync(resolve(cfg.host.trusted_root!), { recursive: true });
    git(dirname(trusted), 'clone', '--bare', '--no-local', project, trusted);
  }
  return trusted;
}

export function importGoalBundle(
  cfg: Config,
  project: string,
  goal: { n: number; branch: string },
  exec: ExecFn = execFileSync
): { ok: true; sha: string } | { ok: false; reason: 'bundle_invalid' | 'bundle_wrong_ref' } {
  if (!/^goal\/G\d+-[A-Za-z0-9._-]+$/.test(goal.branch) || !Number.isSafeInteger(goal.n) || goal.n < 1) {
    return { ok: false, reason: 'bundle_wrong_ref' };
  }
  const ref = `refs/heads/${goal.branch}`;
  const trusted = trustedRepoPath(cfg, project);
  const temp = mkdtempSync(join(tmpdir(), 'btm-bundle-'));
  // Worker (user khác) phải ghi được bundle vào đây nhưng không liệt kê được thư mục; tên ngẫu nhiên.
  if (cfg.host.worker_user) chmodSync(temp, 0o733);
  const bundle = join(temp, `G${goal.n}.bundle`);
  try {
    runWorker(cfg, project, ['git', '-C', project, 'bundle', 'create', bundle, ref], exec);
  } catch {
    return { ok: false, reason: 'bundle_invalid' };
  }
  try {
    try { git(trusted, 'bundle', 'verify', bundle); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    let heads: string;
    try { heads = git(trusted, 'bundle', 'list-heads', bundle); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    const rows = heads.trim().split(/\r?\n/).filter(Boolean);
    if (rows.length !== 1) return { ok: false, reason: 'bundle_wrong_ref' };
    const match = /^([0-9a-f]{40,64}) (refs\/heads\/\S+)$/.exec(rows[0]!);
    if (!match || match[2] !== ref) return { ok: false, reason: 'bundle_wrong_ref' };
    const sha = match[1]!;
    git(trusted, 'fetch', '--no-tags', bundle, `${ref}:refs/btm/incoming/G${goal.n}`);
    return { ok: true, sha };
  } catch {
    return { ok: false, reason: 'bundle_invalid' };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// Đưa workspace của worker về đúng sha tin cậy cho nhánh `branch` (main hoặc goal/…) trước mỗi lượt.
export function syncWorkspace(
  cfg: Config,
  project: string,
  branch: string,
  sha: string,
  exec: ExecFn = execFileSync
): void {
  const trusted = trustedRepoPath(cfg, project);
  runWorker(cfg, project, ['git', '-C', project, 'fetch', '--no-tags', trusted, '+refs/heads/*:refs/remotes/trusted/*'], exec);
  runWorker(cfg, project, ['git', '-C', project, 'checkout', '-f', '-B', branch, sha], exec);
}
