import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import { LOGIN_TIMEOUT_MS, loginState, resetLoginFlows, sendLoginCode, startLogin } from '../src/agents/login-flow.ts';

const cfg = { host: { worker_prefix: 'btm-' } } as any;

function fakeChild() {
  const ev = new EventEmitter();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (c) => written.push(String(c)));
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin,
    on: (e: string, fn: (...a: any[]) => void) => ev.on(e, fn),
    kill: vi.fn(),
    exit: (code: number) => ev.emit('exit', code),
    fail: () => ev.emit('error', new Error('spawn sudo ENOENT')),
  };
  return { child, written };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetLoginFlows();
  vi.useRealTimers();
});

describe('P7-T4: đăng nhập trên dashboard', () => {
  it('codex: link + mã từ output (bỏ mã màu), thoát 0 → done; chạy dưới đúng user', async () => {
    const { child } = fakeChild();
    const argv: string[][] = [];
    const { id } = startLogin(cfg, 'jenny-b', 'codex-cli', (f, a) => { argv.push([f, ...a]); return child as any; });
    expect(argv[0]!.slice(0, 4)).toEqual(['sudo', '-n', '-u', 'btm-jenny-b']);
    expect(argv[0]!.slice(-3)).toEqual(['codex', 'login', '--device-auth']);
    child.stdout.write('\x1b[1mOpen\x1b[0m https://auth.openai.com/codex/device\nand enter code ABCD-12345\n');
    await tick();
    expect(loginState(id)).toEqual({ state: 'waiting', key: 'jenny-b', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', error: undefined });
    expect(() => startLogin(cfg, 'jenny-c', 'codex-cli', () => child as any)).toThrow('another login');
    child.exit(0);
    expect(loginState(id)?.state).toBe('done');
  });

  it('claude: link → needs_code; gửi mã vào stdin; mã lạ bị từ chối; thoát lỗi → failed', async () => {
    const { child, written } = fakeChild();
    const { id } = startLogin(cfg, 'elon-b', 'claude-code', () => child as any);
    child.stdout.write('Browser didn\'t open? Use the url below to sign in:\nhttps://claude.ai/oauth/authorize?code=true&x=1\nPaste code here if prompted > ');
    await tick();
    expect(loginState(id)).toMatchObject({ state: 'needs_code', url: 'https://claude.ai/oauth/authorize?code=true&x=1' });
    expect(() => sendLoginCode(id, 'has space')).toThrow('bad code');
    sendLoginCode(id, 'abc#def');
    await tick();
    expect(written.join('')).toBe('abc#def\n');
    child.exit(1);
    expect(loginState(id)).toMatchObject({ state: 'failed', error: 'login exited 1' });
    expect(() => sendLoginCode(id, 'x')).toThrow('no login');
  });

  it('quá 10 phút → failed timeout, kill tiến trình', () => {
    vi.useFakeTimers();
    const { child } = fakeChild();
    const { id } = startLogin(cfg, 'jenny-b', 'codex-cli', () => child as any);
    vi.advanceTimersByTime(LOGIN_TIMEOUT_MS + 1);
    expect(loginState(id)).toMatchObject({ state: 'failed', error: 'timeout' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('review L2: lỗi spawn không làm sập BTM → failed; onDone chỉ gọi khi thoát 0', async () => {
    const { child } = fakeChild();
    const done = vi.fn();
    const { id } = startLogin(cfg, 'jenny-b', 'codex-cli', () => child as any, done);
    child.exit(0);
    expect(done).toHaveBeenCalledTimes(1);
    expect(loginState(id)?.state).toBe('done');
    resetLoginFlows();
    const c2 = fakeChild().child as any;
    const done2 = vi.fn();
    const r2 = startLogin(cfg, 'jenny-c', 'codex-cli', () => c2, done2);
    c2.exit(1);
    expect(done2).not.toHaveBeenCalled();
    expect(loginState(r2.id)?.state).toBe('failed');
    resetLoginFlows();
    const c3 = fakeChild().child;
    const r3 = startLogin(cfg, 'jenny-d', 'codex-cli', () => c3 as any);
    expect(() => c3.fail()).not.toThrow(); // không có handler 'error' → EventEmitter sẽ throw (sập BTM)
    expect(loginState(r3.id)).toMatchObject({ state: 'failed', error: 'login could not start' });
  });

  it('agy không đăng nhập trên dashboard được; không cách ly → lỗi', () => {
    expect(() => startLogin(cfg, 'jacky-b', 'antigravity-cli', () => fakeChild().child as any)).toThrow('not supported');
    expect(() => startLogin({ host: {} } as any, 'jenny-b', 'codex-cli', () => fakeChild().child as any)).toThrow('isolation required');
  });
});
