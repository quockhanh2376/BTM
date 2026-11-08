import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../config.ts';
import type { ProcResult } from '../runner/run.ts';

export interface EnergyWindow {
  name: '5h' | 'week';
  remainingPercent: number;
  resetsAt: string; // ISO
}

export interface EnergyReading {
  agent: string;
  status: 'fresh' | 'unknown';
  windows: EnergyWindow[];
  readAt: string; // ISO
  note?: string;
}

/**
 * Phân tích JSON output của lệnh `agy -p /quota --output-format json`.
 * Trích xuất 2 dòng của `group` (mặc định 'Gemini Models'):
 * "Five Hour Limit Remaining" -> '5h'
 * "Weekly Limit Remaining" -> 'week'
 * Trả về null nếu thiếu dòng hoặc JSON không hợp lệ.
 */
export function parseAgyQuota(json: string, group = 'Gemini Models'): EnergyWindow[] | null {
  if (!json || typeof json !== 'string') return null;

  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    // Thử làm sạch mã ANSI nếu có
    const cleaned = json.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
    try {
      data = JSON.parse(cleaned);
    } catch {
      // Tìm khối JSON {...} trong chuỗi
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end <= start) return null;
      try {
        data = JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }

  if (!data || typeof data.response !== 'string') return null;

  const lines = data.response.split(/\r?\n/);
  let fiveHour: EnergyWindow | null = null;
  let week: EnergyWindow | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split('\t').map((c: string) => c.trim());
    if (cols.length < 4) continue;

    const [grp, limitName, pctStr, resetsAt] = cols;
    if (grp !== group) continue;
    if (!resetsAt || Number.isNaN(Date.parse(resetsAt))) continue;

    const pctMatch = pctStr.match(/^(-?[\d.]+)%?$/);
    if (!pctMatch) continue;
    const remainingPercent = Number(pctMatch[1]);
    if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) continue;

    if (limitName === 'Five Hour Limit Remaining') {
      fiveHour = { name: '5h', remainingPercent, resetsAt };
    } else if (limitName === 'Weekly Limit Remaining') {
      week = { name: 'week', remainingPercent, resetsAt };
    }
  }

  if (!fiveHour || !week) return null;
  return [fiveHour, week];
}

interface FileWithMtime {
  path: string;
  mtimeMs: number;
}

function findJsonlFiles(dir: string): FileWithMtime[] {
  const result: FileWithMtime[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...findJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(fullPath);
          result.push({ path: fullPath, mtimeMs: st.mtimeMs });
        } catch {
          // Bỏ qua file lỗi stat
        }
      }
    }
  } catch {
    // Bỏ qua lỗi đọc thư mục
  }
  return result;
}

/**
 * Đọc hạn mức Codex từ file *.jsonl mới nhất theo mtime dưới codexHome/sessions.
 * Quét từ cuối lên, tìm bản ghi đầu tiên có rate_limits.primary và secondary.
 * primary (300 phút) -> '5h', secondary (10080 phút) -> 'week'.
 */
export function readCodexLimits(codexHome: string): { windows: EnergyWindow[]; at: string } | null {
  if (!codexHome) return null;
  const sessionsDir = join(codexHome, 'sessions');
  if (!existsSync(sessionsDir)) return null;

  const jsonlFiles = findJsonlFiles(sessionsDir);
  if (jsonlFiles.length === 0) return null;

  // Sắp xếp file mới nhất lên đầu
  jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const latestFile = jsonlFiles[0];
  let content: string;
  try {
    content = readFileSync(latestFile.path, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const obj = JSON.parse(line);
      const rateLimits = obj?.payload?.rate_limits ?? obj?.rate_limits;
      if (!rateLimits) continue;

      const p = rateLimits.primary;
      const s = rateLimits.secondary;
      if (
        p &&
        s &&
        typeof p.used_percent === 'number' &&
        Number.isFinite(p.used_percent) &&
        p.used_percent >= 0 &&
        p.used_percent <= 100 &&
        typeof s.used_percent === 'number' &&
        Number.isFinite(s.used_percent) &&
        s.used_percent >= 0 &&
        s.used_percent <= 100 &&
        typeof p.resets_at === 'number' &&
        Number.isFinite(p.resets_at) &&
        typeof s.resets_at === 'number' &&
        Number.isFinite(s.resets_at)
      ) {
        const primaryRemaining = 100 - p.used_percent;
        const secondaryRemaining = 100 - s.used_percent;
        const primaryResetsAt = new Date(p.resets_at * 1000).toISOString();
        const secondaryResetsAt = new Date(s.resets_at * 1000).toISOString();
        const at = typeof obj.timestamp === 'string' ? obj.timestamp : new Date(latestFile.mtimeMs).toISOString();

        return {
          windows: [
            { name: '5h', remainingPercent: primaryRemaining, resetsAt: primaryResetsAt },
            { name: 'week', remainingPercent: secondaryRemaining, resetsAt: secondaryResetsAt }
          ],
          at
        };
      }
    } catch {
      // Dòng lỗi/ghi dở -> tiếp tục lùi lại dòng trước
      continue;
    }
  }

  return null;
}

/**
 * Đọc Energy của agent theo công cụ đã cấu hình.
 * - claude-code: unknown, note 'CLI không có lệnh hạn mức'
 * - antigravity-cli: chạy script agy /quota qua deps.run
 * - codex-cli: đọc từ sessions của codex
 * Mọi lỗi -> unknown + note ngắn.
 */
export async function readEnergy(
  agent: string,
  tool: Tool,
  deps: {
    run: (argv: string[]) => Promise<ProcResult>;
    codexHome: string;
    now: () => Date;
    timeoutMs?: number;
  }
): Promise<EnergyReading> {
  const readAt = deps.now().toISOString();

  if (tool === 'claude-code') {
    return {
      agent,
      status: 'unknown',
      windows: [],
      readAt,
      note: 'CLI không có lệnh hạn mức'
    };
  }

  if (tool === 'antigravity-cli') {
    try {
      const timeoutMs = deps.timeoutMs ?? 60_000;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<{ timedOutByRace: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOutByRace: true }), timeoutMs);
      });

      let res: ProcResult;
      try {
        const raceResult = await Promise.race([
          deps.run([
            'script',
            '-qec',
            'agy -p /quota --output-format json --print-timeout 50s',
            '/dev/null'
          ]),
          timeoutPromise
        ]);

        if ('timedOutByRace' in raceResult) {
          return {
            agent,
            status: 'unknown',
            windows: [],
            readAt,
            note: 'Lệnh đọc hạn mức quá thời gian (timeout 60s)'
          };
        }
        res = raceResult;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }

      if (res.timedOut) {
        return {
          agent,
          status: 'unknown',
          windows: [],
          readAt,
          note: 'Lệnh đọc hạn mức quá thời gian (timeout)'
        };
      }

      if (res.exitCode !== 0) {
        const errorDetail = res.output ? `: ${res.output.slice(0, 100).trim()}` : '';
        return {
          agent,
          status: 'unknown',
          windows: [],
          readAt,
          note: `Lệnh agy /quota thất bại (exit code ${res.exitCode})${errorDetail}`
        };
      }

      const windows = parseAgyQuota(res.output);
      if (!windows) {
        return {
          agent,
          status: 'unknown',
          windows: [],
          readAt,
          note: 'Không phân tích được hạn mức agy từ output'
        };
      }

      return {
        agent,
        status: 'fresh',
        windows,
        readAt
      };
    } catch (err) {
      return {
        agent,
        status: 'unknown',
        windows: [],
        readAt,
        note: err instanceof Error ? err.message : String(err)
      };
    }
  }

  if (tool === 'codex-cli') {
    try {
      const limits = readCodexLimits(deps.codexHome);
      if (!limits) {
        return {
          agent,
          status: 'unknown',
          windows: [],
          readAt,
          note: 'Không có dữ liệu hạn mức trong sessions codex'
        };
      }

      return {
        agent,
        status: 'fresh',
        windows: limits.windows,
        readAt: limits.at
      };
    } catch (err) {
      return {
        agent,
        status: 'unknown',
        windows: [],
        readAt,
        note: err instanceof Error ? err.message : String(err)
      };
    }
  }

  return {
    agent,
    status: 'unknown',
    windows: [],
    readAt,
    note: `Công cụ ${tool} không hỗ trợ đọc hạn mức`
  };
}
