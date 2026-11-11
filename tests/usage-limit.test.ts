import { describe, expect, it } from 'vitest';
import { detectUsageLimit } from '../src/agents/usage-limit.ts';

const now = new Date('2026-11-11T10:00:00Z');
const fail = (output: string) => ({ exitCode: 1, timedOut: false, output });

describe('P6-T2: nhận lỗi hết hạn mức (mẫu thật từ team/runs)', () => {
  it('agy: RESOURCE_EXHAUSTED + "Resets in 105h50m1s" → giờ hồi', () => {
    const out = 'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 105h50m1s.","status":"RESOURCE_EXHAUSTED"}';
    const hit = detectUsageLimit('antigravity-cli', fail(out), now);
    expect(hit?.resetsAt).toBe(new Date(now.getTime() + (105 * 3600 + 50 * 60 + 1) * 1000).toISOString());
    expect(detectUsageLimit('antigravity-cli', fail('error: Individual quota reached. Please upgrade.'), now)).toEqual({ resetsAt: null });
  });
  it('codex: "You\'ve hit your usage limit … try again at 1:07 PM" → 13:07 giờ máy', () => {
    const out = "{\"type\":\"turn.failed\",\"error\":{\"message\":\"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:07 PM.\"}}";
    const hit = detectUsageLimit('codex-cli', fail(out), now)!;
    const d = new Date(hit.resetsAt!);
    expect([d.getHours(), d.getMinutes()]).toEqual([13, 7]);
    expect(d.getTime()).toBeGreaterThan(now.getTime());
  });
  it('claude: "Claude AI usage limit reached|<epoch>" và "5-hour limit reached · resets 3pm"', () => {
    expect(detectUsageLimit('claude-code', fail('Claude AI usage limit reached|1794405600'), now)).toEqual({ resetsAt: new Date(1794405600 * 1000).toISOString() });
    const hit = detectUsageLimit('claude-code', fail('5-hour limit reached ∙ resets 3pm'), now)!;
    expect(new Date(hit.resetsAt!).getHours()).toBe(15);
  });
  it('không nhận: lượt thành công, quá giờ, hoặc chuỗi nằm giữa output (agent in ra trong code/test)', () => {
    const msg = 'RESOURCE_EXHAUSTED Individual quota reached';
    expect(detectUsageLimit('antigravity-cli', { exitCode: 0, timedOut: false, output: msg }, now)).toBeNull();
    expect(detectUsageLimit('antigravity-cli', { exitCode: null, timedOut: true, output: msg }, now)).toBeNull();
    expect(detectUsageLimit('antigravity-cli', fail(msg + '\n' + 'x'.repeat(6000)), now)).toBeNull();
    expect(detectUsageLimit('codex-cli', fail('tests failed: 3'), now)).toBeNull();
  });
});
