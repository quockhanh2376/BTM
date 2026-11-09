import { checkForbiddenEnv, type Config, type Tool } from '../config.ts';
import type { ProcResult } from '../runner/run.ts';

export type LoginState = 'ok' | 'expiring' | 'relogin' | 'api_key' | 'unknown';

export interface LoginHealth {
  agent: string;
  state: LoginState;
  detail: string;
  expiresAt?: string;
}

export interface CheckLoginDeps {
  run: (argv: string[]) => Promise<ProcResult>;
  env: NodeJS.ProcessEnv;
  cfg: Config;
  now: () => Date;
  agyQuotaOk?: boolean;
  agyQuotaOutput?: string;
}

const RUN_TIMEOUT_MS = 60_000;

/**
 * Bọc lời gọi deps.run bằng Promise.race với timeout 60 giây.
 */
async function runWithTimeout(
  run: (argv: string[]) => Promise<ProcResult>,
  argv: string[],
  timeoutMs: number = RUN_TIMEOUT_MS
): Promise<ProcResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('LOGIN_TIMEOUT'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([run(argv), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Trích xuất đối tượng JSON từ output chuỗi, xử lý mã ANSI nếu có.
 */
function extractJson(raw: string): any {
  if (!raw || typeof raw !== 'string') return null;

  try {
    return JSON.parse(raw);
  } catch {
    // Thử làm sạch mã ANSI
    const cleaned = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}

/**
 * Định dạng ngày tháng thành chuỗi dd/mm
 */
function formatDayMonth(dateStr: string, dateObj: Date): string {
  if (typeof dateStr === 'string') {
    const match = dateStr.match(/^\d{4}-(\d{2})-(\d{2})/);
    if (match) {
      return `${match[2]}/${match[1]}`;
    }
  }
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

/**
 * Kiểm tra trạng thái đăng nhập của một agent theo công cụ CLI tương ứng:
 * - checkForbiddenEnv: phát hiện API key đè môi trường -> state: 'api_key'
 * - claude-code: chạy `claude auth status` (JSON) với timeout 60s
 * - codex-cli: chạy `codex login status` với timeout 60s
 * - antigravity-cli: phân loại theo agyQuotaOk hoặc agyQuotaOutput, không chạy CLI
 */
export async function checkLogin(
  agent: string,
  tool: Tool,
  deps: CheckLoginDeps
): Promise<LoginHealth> {
  // 1. Kiểm tra biến môi trường bị cấm trước tiên
  const forbidden = checkForbiddenEnv(deps.env, deps.cfg.login.forbidden_env);
  if (forbidden.length > 0) {
    return {
      agent,
      state: 'api_key',
      detail: `API key đè đăng nhập: ${forbidden.join(', ')}`,
    };
  }

  // 2. claude-code
  if (tool === 'claude-code') {
    try {
      const cmd = deps.cfg?.agents?.[agent]?.command || 'claude';
      const res = await runWithTimeout(deps.run, [cmd, 'auth', 'status']);

      if (res.timedOut) {
        return {
          agent,
          state: 'unknown',
          detail: 'Không kiểm tra được',
        };
      }

      const data = extractJson(res.output);
      if (!data || typeof data !== 'object') {
        return {
          agent,
          state: 'unknown',
          detail: 'Không kiểm tra được',
        };
      }

      if (data.loggedIn === false) {
        return {
          agent,
          state: 'relogin',
          detail: 'Cần đăng nhập lại',
        };
      }

      if (data.loggedIn === true) {
        if (typeof data.loginExpiresAt === 'string') {
          const isIsoFormat = /^\d{4}-\d{2}-\d{2}/.test(data.loginExpiresAt);
          const exp = new Date(data.loginExpiresAt);
          if (isIsoFormat && !Number.isNaN(exp.getTime())) {
            const diffMs = exp.getTime() - deps.now().getTime();
            const diffDays = diffMs / (1000 * 60 * 60 * 24);
            const warnDays = deps.cfg.login.warn_expiry_days;

            if (diffDays < warnDays) {
              const formattedDate = formatDayMonth(data.loginExpiresAt, exp);
              return {
                agent,
                state: 'expiring',
                detail: `Hết hạn ${formattedDate}`,
                expiresAt: exp.toISOString(),
              };
            }

            return {
              agent,
              state: 'ok',
              detail: 'Ổn',
              expiresAt: exp.toISOString(),
            };
          }
        }

        return {
          agent,
          state: 'ok',
          detail: 'Ổn',
        };
      }

      return {
        agent,
        state: 'unknown',
        detail: 'Không kiểm tra được',
      };
    } catch {
      return {
        agent,
        state: 'unknown',
        detail: 'Không kiểm tra được',
      };
    }
  }

  // 3. codex-cli
  if (tool === 'codex-cli') {
    try {
      const cmd = deps.cfg?.agents?.[agent]?.command || 'codex';
      const res = await runWithTimeout(deps.run, [cmd, 'login', 'status']);

      if (res.timedOut) {
        return {
          agent,
          state: 'unknown',
          detail: 'Không kiểm tra được',
        };
      }

      if (res.output && res.output.includes('API key')) {
        return {
          agent,
          state: 'api_key',
          detail: 'API key đè đăng nhập',
        };
      }

      if (res.exitCode === 0 && res.output && res.output.includes('Logged in using ChatGPT')) {
        return {
          agent,
          state: 'ok',
          detail: 'Ổn',
        };
      }

      return {
        agent,
        state: 'relogin',
        detail: 'Cần đăng nhập lại',
      };
    } catch {
      return {
        agent,
        state: 'unknown',
        detail: 'Không kiểm tra được',
      };
    }
  }

  // 4. antigravity-cli
  if (tool === 'antigravity-cli') {
    if (deps.agyQuotaOk === true) {
      return {
        agent,
        state: 'ok',
        detail: 'Ổn',
      };
    }

    if (deps.agyQuotaOutput) {
      const lower = deps.agyQuotaOutput.toLowerCase();
      if (lower.includes('login') || lower.includes('sign in') || lower.includes('auth')) {
        return {
          agent,
          state: 'relogin',
          detail: 'Cần đăng nhập lại',
        };
      }
    }

    return {
      agent,
      state: 'unknown',
      detail: 'Không kiểm tra được',
    };
  }

  return {
    agent,
    state: 'unknown',
    detail: 'Không kiểm tra được',
  };
}
