import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import { git, gitAsync } from '../git.ts';
import { readProjectKey } from '../ticket/goal.ts';

// Decision 0006: sau khi goal merge vào main, core (không phải agent) gắn tag v<version> và push main + tag
// lên GitHub bằng deploy key của project. Không force-push. Kết quả lưu ở settings để dashboard hiện.
// 2026-11-14 (repo GameTest-BTM public): KHÔNG đẩy thư mục team/ (ghi chú của anh, ticket, báo cáo, câu hỏi).
// Mỗi release = một "commit phát hành": cây của main bỏ RELEASE_EXCLUDE, cha là commit đang ở GitHub (ls-remote)
// → push fast-forward, không force. Lịch sử cũ trên GitHub giữ nguyên.

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
export const RELEASE_EXCLUDE = ['team'];

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

const gitIn = (repo: string, args: string[], input: string) =>
  execFileSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: repo, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

/** Cây của commit, bỏ các mục cấp gốc trong exclude. */
export function treeWithout(repo: string, commit: string, exclude: string[]): string {
  const entries = git(repo, 'ls-tree', '-z', commit).split('\0').filter(Boolean)
    .filter((line) => !exclude.includes(line.slice(line.indexOf('\t') + 1)));
  return gitIn(repo, ['mktree', '-z'], entries.map((e) => `${e}\0`).join(''));
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
    const ssh = `ssh -i '${keyFile}' -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${knownHosts}'`;
    const url = `git@github.com:${target}.git`;
    const mainSha = git(repo, 'rev-parse', `refs/heads/${branch}`).trim();
    const tree = treeWithout(repo, mainSha, RELEASE_EXCLUDE);

    let tagSha = '';
    try { tagSha = git(repo, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`).trim(); } catch {}
    // Push lại sau lỗi: dùng commit phát hành cũ nếu cùng nội dung; khác thì không ghi đè tag (không gọi GitHub).
    if (tagSha && git(repo, 'rev-parse', `${tagSha}^{tree}`).trim() !== tree) { info.error = `tag_exists:${tag}`; return save(); }

    // Cha = commit đang ở GitHub (phải có sẵn ở đây vì lần trước đẩy từ đây); repo trống thì commit đầu tiên.
    const remoteLine = String(await runGit(repo, ['-c', `core.sshCommand=${ssh}`, 'ls-remote', url, `refs/heads/${branch}`], PUSH_TIMEOUT_MS) || '').trim();
    const remoteSha = /^([0-9a-f]{40,64})\s/.exec(remoteLine)?.[1] ?? '';
    if (remoteSha) {
      try { git(repo, 'cat-file', '-e', `${remoteSha}^{commit}`); } catch { info.error = 'remote_main_unknown'; return save(); }
    }

    let releaseSha: string;
    if (tagSha) {
      releaseSha = tagSha;
    } else {
      const parentArgs = remoteSha ? ['-p', remoteSha] : [];
      releaseSha = gitIn(repo, ['-c', 'user.name=core', '-c', 'user.email=core@btm.local', 'commit-tree', tree, ...parentArgs, '-F', '-'],
        `${tag}: G${n} ${goal.title}`.slice(0, 200) + `\n\nRelease of ${branch} ${mainSha.slice(0, 7)} without ${RELEASE_EXCLUDE.join(', ')}/.\n`);
      git(repo, '-c', 'user.name=core', '-c', 'user.email=core@btm.local', 'tag', '-a', tag, '-m', `G${n}: ${goal.title}`.slice(0, 200), releaseSha);
    }
    await runGit(repo, ['-c', `core.sshCommand=${ssh}`, 'push', '--porcelain', url,
      `${releaseSha}:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`], PUSH_TIMEOUT_MS);
    info.ok = true;
  } catch (err) {
    info.error = shortError(err);
  }
  info.at = new Date().toISOString();
  return save();
}
