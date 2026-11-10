import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { git } from '../git.ts';
import { wrapForWorker, type ExecFn } from './worker.ts';

// Thiết kế (plan 4.5, "Đổi thiết kế"): checkout tin cậy do BTM sở hữu là "project" của store; agent chỉ chạy
// trong workspace của worker. Mỗi lượt: syncWorkspace (worker kéo từ checkout) → agent → importTurn (worker đóng
// bundle, BTM nhập vào checkout). BTM không bao giờ chạy git trong workspace (worker sửa được .git/config ở đó).

const TURN_MSG = 'btm-turn';
const TURN_NAME = 'btm-turn';

export type TurnImport = { ok: true; changed: boolean } | { ok: false; reason: 'bundle_invalid' | 'bundle_wrong_ref' | 'sync_failed' };

function runWorker(cfg: Config, cwd: string, argv: string[], exec: ExecFn): string {
  const wrapped = wrapForWorker(cfg, argv, cwd);
  const out = exec(wrapped[0]!, wrapped.slice(1), { stdio: 'pipe' });
  return Buffer.isBuffer(out) ? out.toString('utf8') : typeof out === 'string' ? out : '';
}

// git của worker: đọc checkout tin cậy (user khác sở hữu) cần safe.directory; không chạy hook.
const W_GIT = ['git', '-c', 'safe.directory=*', '-c', 'core.hooksPath=/dev/null'];

export function isIsolated(cfg: Config): boolean {
  return Boolean(cfg.host.worker_user);
}

export function trustedCheckoutPath(cfg: Config, name: string): string {
  const root = cfg.host.trusted_root;
  if (!root) throw new Error('host.trusted_root is required when host.worker_user is set');
  return join(resolve(root), basename(resolve(name)));
}

export function workspacePath(cfg: Config, checkout: string): string {
  return join(resolve(cfg.host.projects_root), basename(resolve(checkout)));
}

// Tạo checkout tin cậy từ workspace hiện có (chỉ lúc chuyển sang cách ly – anh chạy `btm isolate`).
export function ensureTrustedCheckout(cfg: Config, workspace: string): string {
  const trusted = trustedCheckoutPath(cfg, workspace);
  if (!existsSync(join(trusted, '.git'))) {
    mkdirSync(resolve(cfg.host.trusted_root!), { recursive: true });
    git(resolve(cfg.host.trusted_root!), 'clone', '--no-local', '--no-hardlinks', workspace, trusted);
  }
  return trusted;
}

function currentBranch(checkout: string): string {
  const ref = git(checkout, 'symbolic-ref', '-q', 'HEAD').trim();
  if (!ref.startsWith('refs/heads/')) throw new Error('checkout tin cậy không ở trên nhánh nào');
  return ref.slice('refs/heads/'.length);
}

// Worker đưa workspace về đúng nhánh + sha hiện tại của checkout tin cậy (giữ file ignored như node_modules).
export function syncWorkspace(cfg: Config, checkout: string, exec: ExecFn = execFileSync): void {
  const ws = workspacePath(cfg, checkout);
  const branch = currentBranch(checkout);
  const sha = git(checkout, 'rev-parse', 'HEAD').trim();
  if (!existsSync(join(ws, '.git'))) {
    runWorker(cfg, resolve(cfg.host.projects_root), [...W_GIT, 'clone', '--no-local', '--no-checkout', checkout, ws], exec);
  }
  runWorker(cfg, ws, [...W_GIT, '-C', ws, 'fetch', '--no-tags', '--force', checkout, `+refs/heads/${branch}:refs/remotes/trusted/${branch}`], exec);
  runWorker(cfg, ws, [...W_GIT, '-C', ws, 'checkout', '-f', '-B', branch, sha], exec);
  runWorker(cfg, ws, [...W_GIT, '-C', ws, 'clean', '-fd'], exec);
}

// Sau lượt: worker commit tạm mọi thay đổi + đóng bundle đúng nhánh; BTM nhập vào checkout tin cậy rồi bỏ commit
// tạm (reset --mixed) → checkout ở đúng trạng thái như khi agent chạy trực tiếp trong đó; guard/gate Plan 4 xử lý tiếp.
export function importTurn(cfg: Config, checkout: string, exec: ExecFn = execFileSync): TurnImport {
  const ws = workspacePath(cfg, checkout);
  const branch = currentBranch(checkout);
  const ref = `refs/heads/${branch}`;
  const temp = mkdtempSync(join(tmpdir(), 'btm-bundle-'));
  // Worker (user khác) ghi được bundle vào đây nhưng không liệt kê được thư mục; tên ngẫu nhiên.
  chmodSync(temp, 0o733);
  const bundle = join(temp, 'turn.bundle');
  try {
    try {
      runWorker(cfg, ws, [...W_GIT, '-C', ws, 'checkout', '-q', branch], exec);
      runWorker(cfg, ws, [...W_GIT, '-C', ws, 'add', '-A'], exec);
      runWorker(cfg, ws, [...W_GIT, '-C', ws, '-c', `user.name=${TURN_NAME}`, '-c', 'user.email=btm@btm.local',
        'commit', '-q', '--allow-empty', '--no-verify', '-m', TURN_MSG], exec);
      runWorker(cfg, ws, [...W_GIT, '-C', ws, 'bundle', 'create', bundle, ref], exec);
    } catch {
      return { ok: false, reason: 'bundle_invalid' };
    }
    try { git(checkout, 'bundle', 'verify', bundle); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    let heads: string;
    try { heads = git(checkout, 'bundle', 'list-heads', bundle); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    const rows = heads.trim().split(/\r?\n/).filter(Boolean);
    const m = rows.length === 1 ? /^([0-9a-f]{40,64}) (\S+)$/.exec(rows[0]!) : null;
    if (!m || m[2] !== ref) return { ok: false, reason: 'bundle_wrong_ref' };
    const incoming = 'refs/btm/incoming';
    git(checkout, 'fetch', '--no-tags', '--force', bundle, `${ref}:${incoming}`);
    const before = git(checkout, 'rev-parse', 'HEAD').trim();
    git(checkout, 'checkout', '-q', '-f', '-B', branch, incoming);
    // Commit tạm do worker tạo luôn nằm trên đỉnh: bỏ nó, giữ thay đổi trong working tree.
    const [subject, name] = git(checkout, 'log', '-1', '--format=%s%x00%cn').trim().split('\0');
    if (subject === TURN_MSG && name === TURN_NAME) git(checkout, 'reset', '-q', '--mixed', 'HEAD~1');
    git(checkout, 'update-ref', '-d', incoming);
    const changed = git(checkout, 'rev-parse', 'HEAD').trim() !== before || Boolean(git(checkout, 'status', '--porcelain').trim());
    return { ok: true, changed };
  } catch {
    return { ok: false, reason: 'bundle_invalid' };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
