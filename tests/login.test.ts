import { describe, it, expect, vi } from 'vitest';
import { checkLogin } from '../src/energy/login.ts';
import { loadConfig, type Config, type Tool } from '../src/config.ts';
import type { ProcResult } from '../src/runner/run.ts';

describe('checkLogin', () => {
  const baseCfg: Config = loadConfig('btm.config.yaml');
  const now = () => new Date('2026-11-08T15:00:00.000Z');

  function makeProc(partial: Partial<ProcResult> & { exitCode: number; output: string }): ProcResult {
    return {
      durationMs: 10,
      timedOut: false,
      ...partial,
    };
  }

  describe('checkForbiddenEnv (áp dụng cho mọi agent và tool)', () => {
    it('trả về api_key khi có OPENAI_API_KEY trong env, không gọi deps.run', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jenny', 'codex-cli', {
        run: runMock,
        env: { OPENAI_API_KEY: 'sk-test-secret' },
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('api_key');
      expect(health.agent).toBe('jenny');
      expect(health.detail).toContain('OPENAI_API_KEY');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('trả về api_key khi có ANTHROPIC_API_KEY cho claude-code', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('elon', 'claude-code', {
        run: runMock,
        env: { ANTHROPIC_API_KEY: 'sk-ant-123' },
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('api_key');
      expect(health.detail).toContain('ANTHROPIC_API_KEY');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('trả về api_key khi có GEMINI_API_KEY cho antigravity-cli', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jacky', 'antigravity-cli', {
        run: runMock,
        env: { GEMINI_API_KEY: 'gm-key-test' },
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('api_key');
      expect(health.detail).toContain('GEMINI_API_KEY');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('liệt kê tất cả các biến môi trường bị cấm khi có nhiều biến', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('elon', 'claude-code', {
        run: runMock,
        env: {
          ANTHROPIC_AUTH_TOKEN: 'token-123',
          GOOGLE_API_KEY: 'goog-123',
        },
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('api_key');
      expect(health.detail).toContain('ANTHROPIC_AUTH_TOKEN');
      expect(health.detail).toContain('GOOGLE_API_KEY');
      expect(runMock).not.toHaveBeenCalled();
    });
  });

  describe('claude-code', () => {
    it('chạy lệnh claude auth status đúng tham số', async () => {
      let executedArgv: string[] = [];
      const health = await checkLogin('elon', 'claude-code', {
        run: async (argv) => {
          executedArgv = argv;
          return makeProc({
            exitCode: 0,
            output: JSON.stringify({ loggedIn: true }),
          });
        },
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(executedArgv).toEqual(['claude', 'auth', 'status']);
      expect(health.state).toBe('ok');
    });

    it('trả về relogin khi loggedIn là false', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({ loggedIn: false }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('relogin');
      expect(health.agent).toBe('elon');
      expect(health.detail).toBe('Re-login needed');
    });

    it('trả về expiring khi loginExpiresAt cách 3 ngày (< warn_expiry_days = 5) với detail "Expires dd/mm"', async () => {
      // now: 2026-11-08T15:00:00Z -> 3 ngày sau: 2026-11-11T15:00:00Z
      const expiresAt = new Date('2026-11-11T15:00:00.000Z').toISOString();
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({
              loggedIn: true,
              loginExpiresAt: expiresAt,
            }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('expiring');
      expect(health.detail).toBe('Expires 11/11');
      expect(health.expiresAt).toBe(expiresAt);
    });

    it('trả về ok khi loginExpiresAt cách 30 ngày (>= warn_expiry_days = 5)', async () => {
      // now: 2026-11-08T15:00:00Z -> 30 ngày sau: 2026-12-08T15:00:00Z
      const expiresAt = new Date('2026-12-08T15:00:00.000Z').toISOString();
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({
              loggedIn: true,
              loginExpiresAt: expiresAt,
            }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
      expect(health.expiresAt).toBe(expiresAt);
    });

    it('trả về ok khi loggedIn là true và không có loginExpiresAt', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({ loggedIn: true }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
    });

    it('bỏ qua loginExpiresAt kiểu boolean (trả về ok, không expiring)', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({
              loggedIn: true,
              loginExpiresAt: true,
            }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
      expect(health.expiresAt).toBeUndefined();
    });

    it('bỏ qua loginExpiresAt kiểu number (trả về ok, không expiring)', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({
              loggedIn: true,
              loginExpiresAt: 1731078000000,
            }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
      expect(health.expiresAt).toBeUndefined();
    });

    it('bỏ qua loginExpiresAt kiểu object (trả về ok, không expiring)', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({
              loggedIn: true,
              loginExpiresAt: { date: '2026-11-11' },
            }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
      expect(health.expiresAt).toBeUndefined();
    });

    it('bỏ qua loginExpiresAt chuỗi không hợp lệ không parse được (trả về ok, không expiring)', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: JSON.stringify({
              loggedIn: true,
              loginExpiresAt: 'not-a-valid-date',
            }),
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
      expect(health.expiresAt).toBeUndefined();
    });

    it('bóc tách JSON thành công ngay cả khi có mã ANSI hoặc text bọc ngoài', async () => {
      const expiresAt = new Date('2026-11-11T15:00:00.000Z').toISOString();
      const payload = JSON.stringify({ loggedIn: true, loginExpiresAt: expiresAt });
      const wrapped = `\u001b[32m${payload}\u001b[0m\n`;

      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: wrapped,
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('expiring');
      expect(health.detail).toBe('Expires 11/11');
    });

    it('trả về unknown khi output không thể phân tích cú pháp JSON', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: 'Not a JSON output at all',
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
    });

    it('trả về unknown khi lệnh claude bị timeout', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () =>
          makeProc({
            exitCode: 124,
            output: '',
            timedOut: true,
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
    });

    it('bọc deps.run bằng timeout 60s trả về unknown khi run không bao giờ resolve', async () => {
      vi.useFakeTimers();
      try {
        const promise = checkLogin('elon', 'claude-code', {
          run: () => new Promise(() => {}),
          env: {},
          cfg: baseCfg,
          now,
        });

        await vi.advanceTimersByTimeAsync(60_000);
        const health = await promise;

        expect(health.state).toBe('unknown');
        expect(health.detail).toBe('Check failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('trả về unknown khi deps.run ném ngoại lệ và không làm lộ token bí mật trong detail', async () => {
      const health = await checkLogin('elon', 'claude-code', {
        run: async () => {
          throw new Error('spawn claude ENOENT token=FAKE_SECRET');
        },
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
      expect(health.detail).not.toContain('token=FAKE_SECRET');
      expect(health.detail).not.toContain('ENOENT');
    });
  });

  describe('codex-cli', () => {
    it('chạy lệnh codex login status đúng tham số', async () => {
      let executedArgv: string[] = [];
      const health = await checkLogin('jenny', 'codex-cli', {
        run: async (argv) => {
          executedArgv = argv;
          return makeProc({
            exitCode: 0,
            output: 'Logged in using ChatGPT\nAccount: jenny@btm.local',
          });
        },
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(executedArgv).toEqual(['codex', 'login', 'status']);
      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
    });

    it('trả về ok khi exitCode 0 và output chứa "Logged in using ChatGPT"', async () => {
      const health = await checkLogin('jenny', 'codex-cli', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: 'Logged in using ChatGPT',
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
    });

    it('trả về api_key khi output chứa "API key"', async () => {
      const health = await checkLogin('jenny', 'codex-cli', {
        run: async () =>
          makeProc({
            exitCode: 0,
            output: 'Logged in using API key (sk-...)',
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('api_key');
      expect(health.detail).toBe('API key overrides login');
    });

    it('trả về relogin khi output là "Not logged in"', async () => {
      const health = await checkLogin('jenny', 'codex-cli', {
        run: async () =>
          makeProc({
            exitCode: 1,
            output: 'Not logged in',
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('relogin');
      expect(health.detail).toBe('Re-login needed');
    });

    it('trả về relogin cho các trường hợp output khác hoặc lỗi đăng nhập', async () => {
      const health = await checkLogin('jenny', 'codex-cli', {
        run: async () =>
          makeProc({
            exitCode: 1,
            output: 'Session expired. Please run `codex login`.',
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('relogin');
    });

    it('trả về unknown khi codex login status bị timeout', async () => {
      const health = await checkLogin('jenny', 'codex-cli', {
        run: async () =>
          makeProc({
            exitCode: 124,
            output: '',
            timedOut: true,
          }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
    });

    it('bọc deps.run bằng timeout 60s trả về unknown khi run không bao giờ resolve cho codex', async () => {
      vi.useFakeTimers();
      try {
        const promise = checkLogin('jenny', 'codex-cli', {
          run: () => new Promise(() => {}),
          env: {},
          cfg: baseCfg,
          now,
        });

        await vi.advanceTimersByTimeAsync(60_000);
        const health = await promise;

        expect(health.state).toBe('unknown');
        expect(health.detail).toBe('Check failed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('trả về unknown khi deps.run ném ngoại lệ và không làm lộ token bí mật trong detail', async () => {
      const health = await checkLogin('jenny', 'codex-cli', {
        run: async () => {
          throw new Error('spawn codex ENOENT token=FAKE_SECRET');
        },
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
      expect(health.detail).not.toContain('token=FAKE_SECRET');
      expect(health.detail).not.toContain('ENOENT');
    });
  });

  describe('antigravity-cli', () => {
    it('không có thông tin (cả agyQuotaOk và agyQuotaOutput đều thiếu) → unknown và không gọi run', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jacky', 'antigravity-cli', {
        run: runMock,
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('trả về ok khi agyQuotaOk là true mà không gọi deps.run', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jacky', 'antigravity-cli', {
        run: runMock,
        env: {},
        cfg: baseCfg,
        now,
        agyQuotaOk: true,
      });

      expect(health.state).toBe('ok');
      expect(health.detail).toBe('Ok');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('trả về relogin khi agyQuotaOutput chứa "login" mà không gọi deps.run', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jacky', 'antigravity-cli', {
        run: runMock,
        env: {},
        cfg: baseCfg,
        now,
        agyQuotaOutput: 'Please login to Google account first',
      });

      expect(health.state).toBe('relogin');
      expect(health.detail).toBe('Re-login needed');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('trả về relogin khi agyQuotaOk là false và agyQuotaOutput chứa "sign in" mà không gọi deps.run', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jacky', 'antigravity-cli', {
        run: runMock,
        env: {},
        cfg: baseCfg,
        now,
        agyQuotaOk: false,
        agyQuotaOutput: 'Sign in with Google is required',
      });

      expect(health.state).toBe('relogin');
      expect(health.detail).toBe('Re-login needed');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('trả về relogin khi agyQuotaOutput chứa "auth" mà không gọi deps.run', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jacky', 'antigravity-cli', {
        run: runMock,
        env: {},
        cfg: baseCfg,
        now,
        agyQuotaOutput: 'Authentication expired, please run agy auth',
      });

      expect(health.state).toBe('relogin');
      expect(health.detail).toBe('Re-login needed');
      expect(runMock).not.toHaveBeenCalled();
    });

    it('trả về unknown khi agyQuotaOutput không chứa từ khóa đăng nhập mà không gọi deps.run', async () => {
      const runMock = vi.fn<(argv: string[]) => Promise<ProcResult>>();
      const health = await checkLogin('jacky', 'antigravity-cli', {
        run: runMock,
        env: {},
        cfg: baseCfg,
        now,
        agyQuotaOutput: 'Internal server error 500',
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
      expect(runMock).not.toHaveBeenCalled();
    });
  });

  describe('công cụ không hỗ trợ', () => {
    it('trả về unknown khi gặp tool lạ', async () => {
      const health = await checkLogin('unknown-agent', 'other-tool' as Tool, {
        run: async () => makeProc({ exitCode: 0, output: '' }),
        env: {},
        cfg: baseCfg,
        now,
      });

      expect(health.state).toBe('unknown');
      expect(health.detail).toBe('Check failed');
    });
  });
});

describe('P5-T3: agent chưa có user Linux', () => {
  const cfg = loadConfig('btm.config.yaml');
  const iso = { ...cfg, host: { ...cfg.host, worker_prefix: 'btm-' } } as Config;
  const res = (output: string): ProcResult => ({ exitCode: 1, timedOut: false, durationMs: 1, output });
  it('sudo báo không có user → relogin kèm lệnh tạo user; agent có user → kiểm như thường', async () => {
    const missing = await checkLogin('kai', 'codex-cli', { run: async () => res("sudo: user 'btm-kai' not found"), env: {}, cfg: iso, now: () => new Date() });
    expect(missing.state).toBe('relogin');
    expect(missing.detail).toContain('btm-kai');
    expect(missing.detail).toContain('BTM_AGENTS="kai"');
    const run = vi.fn(async (argv: string[]) => (argv[0] === 'true' ? res('') : { ...res('Logged in using ChatGPT'), exitCode: 0 }));
    const ok = await checkLogin('jenny', 'codex-cli', { run, env: {}, cfg: iso, now: () => new Date() });
    expect(ok.state).not.toBe('relogin');
    expect(run.mock.calls[0]![0]).toEqual(['true']);
  });
});
