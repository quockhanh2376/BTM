import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import { git, gitAsync } from '../git.ts';
import { readProjectKey } from '../ticket/goal.ts';

// Decision 0006: sau khi goal merge vào main, core (không phải agent) gắn tag v<version> và push main + tag
// lên GitHub bằng deploy key của project. Không force-push. Kết quả lưu ở settings để dashboard hiện.

export interface ReleaseInfo {
  goal: number;
  tag: string;
  target: string;
  url: string;
  ok: boolean;
  error?: string;
  at: string;
}

export const releaseKey = (repo: string, n: number) => `release:${repo}:G${n}`;

const PUSH_TIMEOUT_MS = 120_000;

export function readRelease(store: Store, repo: string, n: number): ReleaseInfo | null {
  const raw = store.getSetting(releaseKey(repo, n));
  if (!raw) return null;
  try { return JSON.parse(raw) as ReleaseInfo; } catch { return null; }
}

/** "owner/repo" nếu project này có cấu hình push, ngược lại null. */
export function releaseTarget(cfg: Config, repo: string): string | null {
  const map = cfg.release?.github ?? {};
  let key: string;
  try { key = readProjectKey(repo); } catch { return null; }
  return Object.hasOwn(map, key) ? map[key]! : null;
}

function tagFor(repo: string, branch: string, n: number): string {
  try {
    const pkg = JSON.parse(git(repo, 'show', `refs/heads/${branch}:package.json`)) as { version?: unknown };
    if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version)) return `v${pkg.version}`;
  } catch {}
  return `G${n}`;
}

// Chỉ giữ dòng lỗi ngắn, bỏ ký tự lạ; stderr của git push không chứa khoá.
function shortError(err: unknown): string {
  const e = err as { stderr?: string; message?: string; killed?: boolean };
  if (e?.killed) return 'push_timeout';
  const line = String(e?.stderr || e?.message || 'push_failed').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? 'push_failed';
  return line.replace(/[^\x20-\x7E]/g, '').slice(0, 200);
}

export async function publishGoal(store: Store, repo: string, cfg: Config, n: number, runGit = gitAsync): Promise<ReleaseInfo | null> {
  const target = releaseTarget(cfg, repo);
  if (!target) return null;
  const key = readProjectKey(repo);
  const goal = store.getGoal(repo, n);
  const branch = cfg.git?.protected_branch || 'main';
  const tag = goal ? tagFor(repo, branch, n) : `G${n}`;
  const info: ReleaseInfo = { goal: n, tag, target, url: `https://github.com/${target}/tree/${tag}`, ok: false, at: new Date().toISOString() };
  const save = () => { store.setSetting(releaseKey(repo, n), JSON.stringify(info)); return info; };

  if (!goal || goal.state !== 'merged') { info.error = 'goal_not_merged'; return save(); }
  const keyDir = join(cfg.host.data_dir, 'keys');
  const keyFile = join(keyDir, key);
  const knownHosts = join(keyDir, 'known_hosts');
  if (!existsSync(keyFile) || !existsSync(knownHosts)) { info.error = 'deploy_key_missing'; return save(); }

  try {
    const mainSha = git(repo, 'rev-parse', `refs/heads/${branch}`).trim();
    let tagSha = '';
    try { tagSha = git(repo, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`).trim(); } catch {}
    if (tagSha && tagSha !== mainSha) { info.error = `tag_exists:${tag}`; return save(); }
    if (!tagSha) git(repo, '-c', 'user.name=core', '-c', 'user.email=core@btm.local', 'tag', '-a', tag, '-m', `G${n}: ${goal.title}`.slice(0, 200), mainSha);
    const ssh = `ssh -i '${keyFile}' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${knownHosts}'`;
    await runGit(repo, ['-c', `core.sshCommand=${ssh}`, 'push', '--porcelain', `git@github.com:${target}.git`,
      `refs/heads/${branch}:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`], PUSH_TIMEOUT_MS);
    info.ok = true;
  } catch (err) {
    info.error = shortError(err);
  }
  info.at = new Date().toISOString();
  return save();
}
