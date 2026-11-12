import { execFileSync } from 'node:child_process';
import type { Config, Tool } from '../config.ts';
import { workerUser, wrapForWorker } from './worker.ts';

// Plan 7 Task 3: quản lý tài khoản (= user Linux của Worker).
// - Tạo user: cần root → wrapper hẹp `btm-account add <user>` (sudoers chỉ cho đúng lệnh này).
// - Đọc/ghi file token: chạy DƯỚI CHÍNH user đó qua btm-worker-exec (không cần root, chỉ đụng home của nó).
// Không bao giờ đưa nội dung token hay stderr (có thể chứa token) vào thông báo lỗi.

export type AdminExec = (
  file: string,
  args: string[],
  options?: { input?: string; maxBuffer?: number; timeout?: number; stdio?: ['pipe', 'pipe', 'pipe'] }
) => Buffer | string;

const defaultExec: AdminExec = (file, args, options) => execFileSync(file, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });

/** File token theo công cụ, đường dẫn tương đối với home (khớp danh sách GIỮ trong btm-worker-reset). */
export const TOKEN_FILES: Record<Tool, string[]> = {
  'claude-code': ['.claude/.credentials.json'],
  'codex-cli': ['.codex/auth.json'],
  'antigravity-cli': ['.gemini/antigravity-cli/antigravity-oauth-token'],
};

const MAX_FILE = 64 * 1024;

function userOf(cfg: Config, key: string): string {
  const user = workerUser(cfg, key);
  if (!user) throw new Error('isolation required');
  return user;
}

function quiet<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new Error(`${what} failed`);
  }
}

export function addWorkerUser(cfg: Config, key: string, exec: AdminExec = defaultExec): void {
  const user = userOf(cfg, key);
  quiet('create user', () => exec('sudo', ['-n', '/usr/local/bin/btm-account', 'add', user], { timeout: 60_000 }));
}

/** Đọc file token của tài khoản (chạy dưới user đó). File không có → bỏ qua. */
export function exportTokens(cfg: Config, key: string, tool: Tool, exec: AdminExec = defaultExec): Record<string, string> {
  const user = userOf(cfg, key);
  const out: Record<string, string> = {};
  for (const rel of TOKEN_FILES[tool]) {
    try {
      const buf = exec(...splitArgv(wrapForWorker(cfg, key, ['cat', '--', rel], `/home/${user}`)), { maxBuffer: MAX_FILE + 1, timeout: 15_000 });
      const text = buf.toString();
      if (text.length > 0 && text.length <= MAX_FILE) out[rel] = text;
    } catch {
      // chưa đăng nhập / không có file
    }
  }
  return out;
}

// Ghi bằng python dưới user đích: chỉ đường dẫn tương đối trong home, file tạm + chmod 600 + replace.
const WRITER = [
  'import json, os, sys',
  'h = os.path.realpath(os.path.expanduser("~"))',
  'for rel, text in json.load(sys.stdin).items():',
  '    if rel.startswith("/") or ".." in rel.split("/"): sys.exit(3)',
  '    p = os.path.join(h, rel)',
  '    d = os.path.dirname(p)',
  '    os.makedirs(d, mode=0o700, exist_ok=True)',
  '    if not os.path.realpath(d).startswith(h + "/"): sys.exit(4)',
  '    t = p + ".btm-tmp"',
  '    fd = os.open(t, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)',
  '    with os.fdopen(fd, "w") as f: f.write(text)',
  '    os.replace(t, p)',
].join('\n');

export function importTokens(cfg: Config, key: string, tool: Tool, files: Record<string, string>, exec: AdminExec = defaultExec): void {
  const user = userOf(cfg, key);
  const allowed = new Set(TOKEN_FILES[tool]);
  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error('no token files');
  for (const [rel, text] of entries) {
    if (!allowed.has(rel)) throw new Error(`file not allowed for ${tool}`);
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FILE) throw new Error('bad token file');
  }
  quiet('write tokens', () =>
    exec(...splitArgv(wrapForWorker(cfg, key, ['python3', '-c', WRITER], `/home/${user}`)), { input: JSON.stringify(files), timeout: 15_000 })
  );
}

/** File token agy từ {email, refresh_token} (định dạng thật, kiểm trên VM 2026-11-12: token{…}, auth_method, id_token_email).
 *  access_token rỗng + expiry đã qua → CLI tự làm mới bằng refresh_token ở lần chạy đầu. */
export function agyFilesFromJson(input: unknown): Record<string, string> {
  const o = input as { email?: unknown; refresh_token?: unknown };
  if (!o || typeof o.refresh_token !== 'string' || !/^[\x21-\x7e]{10,4096}$/.test(o.refresh_token)) throw new Error('refresh_token missing or invalid');
  if (typeof o.email !== 'string' || !/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(o.email)) throw new Error('email missing or invalid');
  const file = {
    token: { access_token: '', token_type: 'Bearer', refresh_token: o.refresh_token, expiry: '1970-01-01T00:00:00Z', expires_in: 0 },
    auth_method: 'consumer',
    id_token_email: o.email,
  };
  return { [TOKEN_FILES['antigravity-cli'][0]!]: JSON.stringify(file) };
}

/** Email đọc từ file token (chỉ agy có sẵn email trong file); null khi không đọc được. */
export function emailFromTokens(tool: Tool, files: Record<string, string>): string | null {
  if (tool !== 'antigravity-cli') return null;
  try {
    const e = JSON.parse(files[TOKEN_FILES['antigravity-cli'][0]!] ?? '').id_token_email;
    return typeof e === 'string' && e.length <= 256 ? e : null;
  } catch {
    return null;
  }
}

function splitArgv(argv: string[]): [string, string[]] {
  return [argv[0]!, argv.slice(1)];
}
