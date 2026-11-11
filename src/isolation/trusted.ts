import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { git } from '../git.ts';
import { workerUser, wrapForWorker, type ExecFn } from './worker.ts';

// Thiết kế (plan 4.5, "Đổi thiết kế" + vòng sửa review 1): checkout tin cậy do BTM sở hữu là "project" của store;
// mỗi agent chạy dưới user Linux riêng, trong workspace riêng <work_root>/<user>/<project>. Mỗi lượt: syncWorkspace
// (worker dựng .git mới, kéo từ checkout) → agent → importTurn (worker in bundle ra stdout, BTM nhập vào checkout).
// BTM không bao giờ chạy git hay đọc file trong workspace; không có thư mục tạm dùng chung giữa BTM và worker.

const TURN_MSG = 'btm-turn';
const TURN_NAME = 'btm-turn';
const MAX_BUNDLE = 1024 * 1024 * 1024;
const MAX_OUT = 1024 * 1024;

export type TurnImport =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'bundle_invalid' | 'bundle_wrong_ref' | 'bundle_unsafe' | 'sync_failed' };

// Mọi lệnh dưới worker có hạn giờ: lệnh treo (filter git, FIFO…) không được khoá event loop của BTM.
function runWorker(cfg: Config, agentId: string, cwd: string, argv: string[], exec: ExecFn, timeout = 120_000): Buffer {
  const wrapped = wrapForWorker(cfg, agentId, argv, cwd);
  const out = exec(wrapped[0]!, wrapped.slice(1), { stdio: 'pipe', maxBuffer: MAX_BUNDLE, timeout, killSignal: 'SIGKILL' });
  return Buffer.isBuffer(out) ? out : Buffer.from(typeof out === 'string' ? out : '');
}

// git của worker: bỏ ~/.gitconfig + config hệ thống (agent sửa được home của mình); đọc checkout tin cậy (user khác
// sở hữu) cần safe.directory; không hook, không fsmonitor, không ký.
const W_GIT = ['env', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_NOSYSTEM=1', 'git', '-c', 'safe.directory=*',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false'];

export function isIsolated(cfg: Config): boolean {
  return Boolean(cfg.host.worker_prefix);
}

export function trustedCheckoutPath(cfg: Config, name: string): string {
  const root = cfg.host.trusted_root;
  if (!root) throw new Error('host.trusted_root is required when host.worker_prefix is set');
  return join(resolve(root), basename(resolve(name)));
}

function userDir(cfg: Config, agentId: string): string {
  const root = cfg.host.work_root;
  if (!root) throw new Error('host.work_root is required when host.worker_prefix is set');
  return join(resolve(root), workerUser(cfg, agentId)!);
}

export function workspacePath(cfg: Config, agentId: string, checkout: string): string {
  return join(userDir(cfg, agentId), basename(resolve(checkout)));
}

// File kết quả cuối của CLI (codex -o): nằm trong thư mục riêng của worker, BTM đọc lại qua worker.
export function workerOutFile(cfg: Config, agentId: string): string {
  return join(userDir(cfg, agentId), '.btm-last.out');
}

// Tạo checkout tin cậy từ workspace hiện có (chỉ lúc chuyển sang cách ly – anh chạy `btm isolate`).
export function ensureTrustedCheckout(cfg: Config, workspace: string): string {
  const trusted = trustedCheckoutPath(cfg, workspace);
  if (!existsSync(join(trusted, '.git'))) {
    mkdirSync(resolve(cfg.host.trusted_root!), { recursive: true });
    git(resolve(cfg.host.trusted_root!), 'clone', '--no-local', '--no-hardlinks', workspace, trusted);
    // clone chỉ tạo nhánh mặc định: lấy đủ nhánh goal/* về làm nhánh local.
    git(trusted, 'fetch', '-q', '--no-tags', '--update-head-ok', 'origin', '+refs/heads/*:refs/heads/*');
  }
  return trusted;
}

function currentBranch(checkout: string): string {
  const ref = git(checkout, 'symbolic-ref', '-q', 'HEAD').trim();
  if (!ref.startsWith('refs/heads/')) throw new Error('trusted checkout is not on a branch');
  return ref.slice('refs/heads/'.length);
}

// Worker dựng lại workspace: .git mới mỗi lượt (không mang config/hook/replace ref của lượt trước), mọi nhánh của
// checkout, đúng nhánh + sha hiện tại; giữ file ignored (node_modules) để khỏi cài lại.
export function syncWorkspace(cfg: Config, agentId: string, checkout: string, exec: ExecFn = execFileSync): void {
  const dir = userDir(cfg, agentId);
  const ws = workspacePath(cfg, agentId, checkout);
  const branch = currentBranch(checkout);
  const sha = git(checkout, 'rev-parse', 'HEAD').trim();
  runWorker(cfg, agentId, dir, ['mkdir', '-p', ws], exec);
  runWorker(cfg, agentId, dir, ['rm', '-rf', join(ws, '.git'), workerOutFile(cfg, agentId), join(ws, STATUS_FILE)], exec);
  runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'init', '-q'], exec);
  // Plan 6 Task 7: file trạng thái của agent không bao giờ vào commit.
  runWorker(cfg, agentId, ws, ['sh', '-c', 'mkdir -p "$2/.git/info" && printf "%s\\n" "$1" >> "$2/.git/info/exclude"', 'sh', STATUS_FILE, ws], exec);
  runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'fetch', '-q', '--no-tags', '--update-head-ok', checkout, '+refs/heads/*:refs/heads/*'], exec);
  runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'checkout', '-q', '-f', '-B', branch, sha], exec);
  // -ff: xoá cả repo lồng (gitlink) agent để lại, không thì mọi lượt sau bị bundle_unsafe.
  runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'clean', '-ffdq'], exec);
}

export const STATUS_FILE = '.btm-status';

// Một dòng, bỏ ký tự điều khiển, tối đa 200 ký tự (agent viết – không tin cậy).
export function cleanStatus(raw: string): string {
  const line = raw.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

// Đọc dòng trạng thái agent tự ghi trong workspace, qua worker (chỉ file thường, timeout ngắn).
export function readWorkerStatus(cfg: Config, agentId: string, checkout: string, exec: ExecFn = execFileSync): string {
  try {
    const f = join(workspacePath(cfg, agentId, checkout), STATUS_FILE);
    const out = runWorker(cfg, agentId, userDir(cfg, agentId), ['sh', '-c', 'test -f "$1" && ! test -L "$1" && head -c 1000 -- "$1"', 'sh', f], exec, 3_000);
    return cleanStatus(out.toString('utf8'));
  } catch {
    return '';
  }
}

export function readWorkerOut(cfg: Config, agentId: string, exec: ExecFn = execFileSync): string {
  try {
    const f = workerOutFile(cfg, agentId);
    // chỉ file thường (FIFO/thiết bị làm head treo); timeout ở runWorker chặn phần còn lại.
    return runWorker(cfg, agentId, userDir(cfg, agentId), ['sh', '-c', 'test -f "$1" && ! test -L "$1" && head -c "$2" -- "$1"', 'sh', f, String(MAX_OUT)], exec, 10_000).toString('utf8');
  } catch {
    return '';
  }
}

// Commit nhập về không được thêm/đổi symlink hay submodule: BTM đọc/ghi file trong checkout sẽ đi xuyên qua chúng.
function hasUnsafeEntries(checkout: string, from: string, to: string): boolean {
  const raw = git(checkout, 'diff-tree', '-r', '--no-renames', from, to);
  return raw.split(/\r?\n/).some((l) => /^:\d{6} (120000|160000) /.test(l));
}

// Sau lượt: worker commit tạm mọi thay đổi + in bundle đúng nhánh ra stdout; BTM ghi vào thư mục riêng (0700), kiểm,
// nhập vào checkout tin cậy rồi bỏ commit tạm (reset --mixed) → checkout ở đúng trạng thái như khi agent chạy trực
// tiếp trong đó; guard/gate Plan 4 xử lý tiếp. Lỗi giữa chừng → đưa checkout về nguyên trạng.
export function importTurn(cfg: Config, agentId: string, checkout: string, exec: ExecFn = execFileSync): TurnImport {
  const ws = workspacePath(cfg, agentId, checkout);
  const branch = currentBranch(checkout);
  const ref = `refs/heads/${branch}`;
  let data: Buffer;
  try {
    // .git/config + info/attributes do agent viết lại (filter, gpg…) → bỏ, dựng config mặc định trước khi add/commit.
    runWorker(cfg, agentId, ws, ['rm', '-f', join(ws, '.git', 'config'), join(ws, '.git', 'info', 'attributes')], exec);
    runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'init', '-q'], exec);
    runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'checkout', '-q', branch], exec);
    runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'add', '-A'], exec, 600_000);
    runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, '-c', `user.name=${TURN_NAME}`, '-c', 'user.email=btm@btm.local',
      'commit', '-q', '--allow-empty', '--no-verify', '-m', TURN_MSG], exec);
    data = runWorker(cfg, agentId, ws, [...W_GIT, '-C', ws, 'bundle', 'create', '-q', '-', ref], exec, 600_000);
  } catch {
    return { ok: false, reason: 'bundle_invalid' };
  }
  const temp = mkdtempSync(join(tmpdir(), 'btm-bundle-'));
  const bundle = join(temp, 'turn.bundle');
  const incoming = 'refs/btm/incoming';
  const before = git(checkout, 'rev-parse', 'HEAD').trim();
  let touched = false;
  try {
    writeFileSync(bundle, data, { mode: 0o600 });
    try { git(checkout, 'bundle', 'verify', '-q', bundle); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    let heads: string;
    try { heads = git(checkout, 'bundle', 'list-heads', bundle); } catch { return { ok: false, reason: 'bundle_invalid' }; }
    const rows = heads.trim().split(/\r?\n/).filter(Boolean);
    const m = rows.length === 1 ? /^([0-9a-f]{40,64}) (\S+)$/.exec(rows[0]!) : null;
    if (!m || m[2] !== ref) return { ok: false, reason: 'bundle_wrong_ref' };
    touched = true;
    git(checkout, 'fetch', '--no-tags', '--force', bundle, `${ref}:${incoming}`);
    if (hasUnsafeEntries(checkout, before, incoming)) return { ok: false, reason: 'bundle_unsafe' };
    git(checkout, 'checkout', '-q', '-f', '-B', branch, incoming);
    // Commit tạm do worker tạo luôn nằm trên đỉnh: bỏ nó, giữ thay đổi trong working tree.
    const [subject, name] = git(checkout, 'log', '-1', '--format=%s%x00%cn').trim().split('\0');
    if (subject === TURN_MSG && name === TURN_NAME) git(checkout, 'reset', '-q', '--mixed', 'HEAD~1');
    const changed = git(checkout, 'rev-parse', 'HEAD').trim() !== before || Boolean(git(checkout, 'status', '--porcelain').trim());
    touched = false;
    return { ok: true, changed };
  } catch {
    return { ok: false, reason: 'bundle_invalid' };
  } finally {
    if (touched) {
      try { git(checkout, 'checkout', '-q', '-f', '-B', branch, before); } catch { /* báo lỗi qua kết quả import */ }
    }
    try { git(checkout, 'update-ref', '-d', incoming); } catch { /* chưa tạo */ }
    rmSync(temp, { recursive: true, force: true });
  }
}
