import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Config, Tool } from '../config.ts';
import { workerKillAll, workerUser, wrapForWorker } from '../isolation/worker.ts';

// Plan 7 Task 4: đăng nhập CLI của tài khoản mới ngay trên dashboard.
// codex: `codex login --device-auth` in link + mã, tự xong khi anh xác nhận trên trình duyệt.
// claude: `claude auth login` in link, chờ anh dán mã trả về (stdin; chạy qua `script` để có pty).
// Output của CLI chỉ giữ trong bộ nhớ để tìm link/mã, KHÔNG ghi log (có thể chứa token).

export type LoginStateName = 'waiting' | 'needs_code' | 'done' | 'failed';
export interface LoginView {
  state: LoginStateName;
  key: string;
  url?: string;
  code?: string;
  error?: string;
}

export interface LoginChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  on(ev: 'exit', fn: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export type SpawnFn = (file: string, args: string[]) => LoginChild;

const defaultSpawn: SpawnFn = (file, args) => spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });

export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUF = 64 * 1024;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

interface Flow extends LoginView {
  id: string;
  tool: Tool;
  child: LoginChild;
  buf: string;
  timer: NodeJS.Timeout;
  onDone?: () => void;
}

let current: Flow | null = null;

export function loginArgv(tool: Tool): string[] {
  if (tool === 'codex-cli') return ['codex', 'login', '--device-auth'];
  if (tool === 'claude-code') return ['script', '-qec', 'claude auth login', '/dev/null'];
  throw new Error('login on dashboard not supported for this tool');
}

function settle(f: Flow, state: 'done' | 'failed', error?: string): void {
  if (f.state === 'done' || f.state === 'failed') return;
  f.state = state;
  if (error) f.error = error;
  clearTimeout(f.timer);
  f.buf = '';
  if (state === 'done') {
    try { f.onDone?.(); } catch {}
  }
}

function onOutput(f: Flow, chunk: Buffer | string): void {
  if (f.state === 'done' || f.state === 'failed') return;
  f.buf = (f.buf + chunk.toString()).replace(ANSI, '').slice(-MAX_BUF);
  if (!f.url) {
    const m = /https:\/\/[^\s"'<>]+(?=\s)/.exec(f.buf); // chờ hết link (output có thể bị cắt giữa chừng)
    if (m) f.url = m[0].slice(0, 500);
  }
  if (f.tool === 'codex-cli' && !f.code) {
    const m = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/.exec(f.buf);
    if (m) f.code = m[0];
  }
  if (f.tool === 'claude-code' && f.url) f.state = 'needs_code';
}

/** onDone: gọi khi đăng nhập xong (thoát 0) – API dùng để bật tài khoản. */
export function startLogin(cfg: Config, key: string, tool: Tool, spawnFn: SpawnFn = defaultSpawn, onDone?: () => void): { id: string } {
  if (current && (current.state === 'waiting' || current.state === 'needs_code')) throw new Error('another login is running');
  const user = workerUser(cfg, key);
  if (!user) throw new Error('isolation required');
  const argv = wrapForWorker(cfg, key, loginArgv(tool), `/home/${user}`);
  const child = spawnFn(argv[0]!, argv.slice(1));
  const f: Flow = {
    id: randomBytes(8).toString('hex'),
    key,
    tool,
    child,
    buf: '',
    state: 'waiting',
    onDone,
    timer: setTimeout(() => {
      settle(f, 'failed', 'timeout');
      try { child.kill('SIGKILL'); } catch {}
      // SIGKILL chỉ trúng sudo; dọn CLI còn chạy dưới user tài khoản.
      try { workerKillAll(cfg, key); } catch {}
    }, LOGIN_TIMEOUT_MS),
  };
  // Lỗi spawn / EPIPE không được làm sập BTM.
  (child as unknown as { on(ev: 'error', fn: () => void): unknown }).on('error', () => settle(f, 'failed', 'login could not start'));
  (child.stdin as unknown as { on?: (ev: 'error', fn: () => void) => unknown } | null)?.on?.('error', () => {});
  child.stdout?.on('data', (c: Buffer) => onOutput(f, c));
  child.stderr?.on('data', (c: Buffer) => onOutput(f, c));
  child.on('exit', (code) => settle(f, code === 0 ? 'done' : 'failed', code === 0 ? undefined : `login exited ${code}`));
  current = f;
  return { id: f.id };
}

export function loginState(id: string): LoginView | null {
  if (!current || current.id !== id) return null;
  const { state, key, url, code, error } = current;
  return { state, key, url, code, error };
}

export function sendLoginCode(id: string, code: string): void {
  if (!current || current.id !== id || current.state !== 'needs_code') throw new Error('no login waiting for a code');
  if (!/^[\x21-\x7e]{1,200}$/.test(code)) throw new Error('bad code');
  current.child.stdin?.write(`${code}\n`);
  current.state = 'waiting';
}

/** Test: dọn flow giữa các test. */
export function resetLoginFlows(): void {
  if (current) clearTimeout(current.timer);
  current = null;
}
