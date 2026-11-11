import type { Tool } from '../config.ts';

// Plan 6 Task 2: nhận lỗi hết hạn mức của CLI ở ĐUÔI output khi lượt THẤT BẠI (agent in chuỗi này trong code/test
// của nó ở giữa output thì không tính). Mẫu thật lấy từ team/runs (agy, Codex); Claude theo mẫu đã biết.

export interface UsageLimitHit {
  resetsAt: string | null;
}

const TAIL = 4000;

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
  if (r.timedOut || r.exitCode === 0) return null;
  const tail = `${r.output.slice(-TAIL)}\n${(r.lastMessage ?? '').slice(-TAIL)}`;

  if (tool === 'antigravity-cli') {
    if (!/RESOURCE_EXHAUSTED|Individual quota reached/.test(tail)) return null;
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
  if (!/usage limit reached|(5-hour|weekly|session) limit reached|You've hit your (usage )?limit/i.test(tail)) return null;
  const m = /resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(tail);
  return { resetsAt: m ? atClock(now, to24(+m[1]!, m[3]), m[2] ? +m[2] : 0) : null };
}

export const usageLimitedKey = (agent: string) => `usage_limited_until:${agent}`;
