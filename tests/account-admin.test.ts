import { describe, expect, it } from 'vitest';
import { addWorkerUser, agyFilesFromJson, emailFromTokens, exportTokens, importTokens, TOKEN_FILES } from '../src/isolation/account-admin.ts';

const cfg = { host: { worker_prefix: 'btm-' } } as any;
const SECRET = 'tok-SECRET-123';

function spy(reply: (file: string, args: string[], input?: string) => string) {
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const exec = (file: string, args: string[], o?: { input?: string }) => {
    calls.push({ file, args, input: o?.input });
    return Buffer.from(reply(file, args, o?.input));
  };
  return { exec, calls };
}

describe('P7-T3: quản lý tài khoản', () => {
  it('addWorkerUser gọi đúng wrapper root; lỗi không lộ stderr', () => {
    const { exec, calls } = spy(() => '');
    addWorkerUser(cfg, 'jacky-b', exec);
    expect(calls[0]).toEqual({ file: 'sudo', args: ['-n', '/usr/local/bin/btm-account', 'add', 'btm-jacky-b'], input: undefined });
    const bad = () => { throw new Error(`stderr: ${SECRET}`); };
    expect(() => addWorkerUser(cfg, 'jacky-b', bad)).toThrow('create user failed');
    expect(() => addWorkerUser({ host: {} } as any, 'jacky-b', exec)).toThrow('isolation required');
  });

  it('exportTokens đọc file dưới chính user đó; file thiếu bỏ qua', () => {
    const { exec, calls } = spy(() => SECRET);
    expect(exportTokens(cfg, 'jenny', 'codex-cli', exec)).toEqual({ '.codex/auth.json': SECRET });
    expect(calls[0]!.args.slice(0, 7)).toEqual(['-n', '-u', 'btm-jenny', '/usr/local/bin/btm-worker-exec', '/home/btm-jenny', '--', 'cat']);
    const missing = () => { throw new Error('No such file'); };
    expect(exportTokens(cfg, 'jenny', 'codex-cli', missing)).toEqual({});
  });

  it('importTokens: chỉ file token của đúng công cụ, gửi qua stdin, lỗi không lộ token', () => {
    const { exec, calls } = spy(() => '');
    expect(() => importTokens(cfg, 'jacky-b', 'codex-cli', { '../../.ssh/authorized_keys': 'x' }, exec)).toThrow('not allowed');
    expect(() => importTokens(cfg, 'jacky-b', 'codex-cli', { '.claude/.credentials.json': 'x' }, exec)).toThrow('not allowed');
    expect(() => importTokens(cfg, 'jacky-b', 'codex-cli', { '.codex/auth.json': 'x'.repeat(70_000) }, exec)).toThrow('bad token file');
    expect(() => importTokens(cfg, 'jacky-b', 'codex-cli', {}, exec)).toThrow('no token files');
    expect(calls).toHaveLength(0);
    importTokens(cfg, 'jacky-b', 'codex-cli', { '.codex/auth.json': SECRET }, exec);
    expect(calls[0]!.args.slice(0, 7)).toEqual(['-n', '-u', 'btm-jacky-b', '/usr/local/bin/btm-worker-exec', '/home/btm-jacky-b', '--', 'python3']);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ '.codex/auth.json': SECRET });
    expect(calls[0]!.args.join(' ')).not.toContain(SECRET);
    let msg = '';
    try {
      importTokens(cfg, 'jacky-b', 'codex-cli', { '.codex/auth.json': SECRET }, () => { throw new Error(SECRET); });
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toBe('write tokens failed');
  });

  it('agyFilesFromJson dựng đúng định dạng file agy; thiếu/sai → lỗi; emailFromTokens đọc lại', () => {
    const files = agyFilesFromJson({ email: 'a@b.c', refresh_token: '1//0abcdefghijkl' });
    const rel = TOKEN_FILES['antigravity-cli'][0]!;
    expect(JSON.parse(files[rel]!)).toEqual({
      token: { access_token: '', token_type: 'Bearer', refresh_token: '1//0abcdefghijkl', expiry: '1970-01-01T00:00:00Z', expires_in: 0 },
      auth_method: 'consumer',
      id_token_email: 'a@b.c',
    });
    expect(emailFromTokens('antigravity-cli', files)).toBe('a@b.c');
    expect(() => agyFilesFromJson({ email: 'a@b.c' })).toThrow('refresh_token');
    expect(() => agyFilesFromJson({ email: 'a@b.c', refresh_token: 'has space inside!' })).toThrow('refresh_token');
    expect(() => agyFilesFromJson({ email: 'nope', refresh_token: '1//0abcdefghijkl' })).toThrow('email');
  });
});
