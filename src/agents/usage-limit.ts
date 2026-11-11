import type { Tool } from '../config.ts';

// Plan 6 Task 2: nhận lỗi hết hạn mức của CLI ở ĐUÔI output khi lượt THẤT BẠI (exit code thật ≠ 0). Chỉ đọc output
// của tiến trình CLI, không đọc lastMessage (chữ của agent). Mẫu chặt, giờ hồi tối đa 7 ngày. Agent vẫn có thể in giả
// đúng mẫu ở cuối rồi thoát lỗi → chỉ tự cho mình nghỉ; monitor gỡ cờ khi Energy đọc được còn đủ (xem monitor.ts).
// Mẫu thật lấy từ team/runs (agy, Codex); Claude theo mẫu đã biết.

export interface UsageLimitHit {
  resetsAt: string | null;
}

const TAIL = 1500;
const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

function atClock(now: Date, h: number, m: number): string {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function to24(h: number, ampm: string | undefined): number {
  if (!ampm) return h;
  const pm = ampm.toLowerCase() === 'pm';
  return (h % 12) + (pm ? 12 : 0);
}

export function detectUsageLimit(
  tool: Tool,
  r: { exitCode: number | null; timedOut: boolean; output: string; lastMessage?: string },
  now: Date
): UsageLimitHit | null {
  if (r.timedOut || r.exitCode === null || r.exitCode === 0) return null;
  const tail = r.output.slice(-TAIL);
  const hit = detectIn(tool, tail, now);
  if (hit?.resetsAt && Date.parse(hit.resetsAt) - now.getTime() > MAX_WAIT_MS) {
    return { resetsAt: new Date(now.getTime() + MAX_WAIT_MS).toISOString() };
  }
  return hit;
}

function detectIn(tool: Tool, tail: string, now: Date): UsageLimitHit | null {

  if (tool === 'antigravity-cli') {
    if (!/Individual quota reached/.test(tail)) return null;
    const m = /Resets in (\d+)h(\d+)m(\d+)s/.exec(tail);
    const ms = m ? ((+m[1]! * 60 + +m[2]!) * 60 + +m[3]!) * 1000 : 0;
    return { resetsAt: m ? new Date(now.getTime() + ms).toISOString() : null };
  }

  if (tool === 'codex-cli') {
    if (!/You've hit your usage limit|usage_limit_reached/.test(tail)) return null;
    const m = /try again at (\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(tail);
    return { resetsAt: m ? atClock(now, to24(+m[1]!, m[3]), +m[2]!) : null };
  }

  // claude-code
  const epoch = /Claude AI usage limit reached\|(\d{10})/.exec(tail);
  if (epoch) return { resetsAt: new Date(+epoch[1]! * 1000).toISOString() };
  // "5-hour limit reached ∙ resets 3pm" – cần cả "limit reached" và "resets <giờ>" trên cùng một dòng.
  const m = /(?:5-hour|weekly|usage) limit reached\W+resets (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(tail);
  if (!m) return null;
  return { resetsAt: atClock(now, to24(+m[1]!, m[3]), m[2] ? +m[2] : 0) };
}

export const usageLimitedKey = (agent: string) => `usage_limited_until:${agent}`;
