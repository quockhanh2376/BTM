import { describe, expect, it } from 'vitest';
import { readWeb } from './helpers.ts';

describe('Chat lúc rảnh: tối đa 5 agent một lượt (anh Zon 2026-11-14)', () => {
  const html = readWeb();
  const lib = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return { chatMoodCfg, livelyTalkPlan };')() as any;

  it('cài đặt nhận 1–5; kế hoạch nói không vượt số đã chọn và có thể đủ 5 người', () => {
    expect(lib.chatMoodCfg('lively', { speakers: 5, livelySec: [30, 60], normalMin: [5, 8] }).speakers).toBe(5);
    expect(lib.chatMoodCfg('lively', { speakers: 6 }).speakers).toBe(3);
    const pool = ['pm', 'dev', 'qc', 'audit', 'backup'];
    const sizes = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const who = lib.livelyTalkPlan(pool, null, 5);
      expect(new Set(who).size).toBe(who.length);
      sizes.add(who.length);
    }
    expect([...sizes].sort()).toEqual([1, 2, 3, 4, 5]);
    for (let i = 0; i < 50; i++) expect(lib.livelyTalkPlan(pool, null, 4).length).toBeLessThanOrEqual(4);
  });

  it('Settings có lựa chọn 4 và 5; Boss không ngồi ghế vẫn được góp chuyện; người thứ 3 trở đi nói cách nhau 1,8 giây', () => {
    expect(html).toContain('<option value="4">4</option><option value="5">5</option>');
    expect(html).toContain("var pool = bossAcc && !seenAgent[bossAcc.agent] ? idle.concat(['backup']) : idle;");
    expect(html).toContain("delay: 1800 * (i + 1)");
  });
});
