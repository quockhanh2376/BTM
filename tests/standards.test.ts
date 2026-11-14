import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.ts';
import { DEFAULT_STANDARDS, readStandards, readUiDefaults, standardsFor, standardsLines, StandardsSchema, STANDARDS_KEY } from '../src/standards.ts';
import { devTicketPrompt, pmTicketPrompt, qcTicketPrompt } from '../src/core/prompts.ts';
import { parseTicket } from '../src/ticket/ticket.ts';

const T = parseTicket('---\nid: GT-0001\ngoal: G1\nnumber: 1\nof: 1\ntitle: "T"\ntype: feat\nsize: S\nscope: ["a.js"]\nacceptance: ["ok"]\ndone_when: "ok"\n---\n', 'GT');

describe('Settings: chuẩn cho mọi project (2026-11-14)', () => {
  it('mặc định: giờ +7, UTF-8, sáng/tối, song ngữ đều bật; dashboard EN + theo máy', () => {
    const store = openStore(':memory:');
    expect(readStandards(store)).toEqual(DEFAULT_STANDARDS);
    expect(readUiDefaults(store)).toEqual({ lang: 'en', theme: 'system' });
    const lines = standardsFor(store);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('UTC+7 (Asia/Ho_Chi_Minh)');
    expect(lines[1]).toContain('UTF-8');
  });

  it('lưu: tắt chuẩn thì mất dòng, chuẩn riêng được làm sạch (≤ 10 dòng, ≤ 200 ký tự), múi giờ lạ bị từ chối, dữ liệu hỏng → mặc định', () => {
    const store = openStore(':memory:');
    const parsed = StandardsSchema.parse({ timezone: { on: false, value: 'Asia/Tokyo' }, utf8: true, theme: false, bilingual: false, custom: ['  Ngày dd/mm/yyyy \u0007 ', '', ...Array.from({ length: 14 }, (_, i) => `c${i}`), 'x'.repeat(500)] });
    expect(parsed.custom).toHaveLength(10);
    expect(parsed.custom[0]).toBe('Ngày dd/mm/yyyy');
    store.setSetting(STANDARDS_KEY, JSON.stringify(parsed));
    const lines = standardsLines(readStandards(store));
    expect(lines).toHaveLength(11);
    expect(lines.join('\n')).not.toContain('Múi giờ');
    expect(StandardsSchema.safeParse({ ...DEFAULT_STANDARDS, timezone: { on: true, value: 'Mars/Olympus' } }).success).toBe(false);
    store.setSetting(STANDARDS_KEY, '{broken');
    expect(readStandards(store)).toEqual(DEFAULT_STANDARDS);
  });

  it('PM đưa vào acceptance, Dev làm theo, QC kiểm và fail khi vi phạm; không có chuẩn thì không thêm dòng', () => {
    const st = ['Unicode: dùng UTF-8'];
    expect(pmTicketPrompt({ n: 1, title: 'x' }, 'GT', 'GT-0001', { standards: st })).toContain('acceptance PHẢI có mục kiểm tương ứng:\n- Unicode: dùng UTF-8');
    expect(devTicketPrompt(T, 'jenny', [], [], false, '', st)).toContain('Chuẩn bắt buộc của anh Zon cho mọi project (làm đúng trong phần bạn sửa):\n- Unicode: dùng UTF-8');
    expect(qcTicketPrompt(T, 'abc', 'elon', [], [], st)).toContain('vi phạm thì fail và ghi vào bugs:\n- Unicode: dùng UTF-8');
    for (const p of [pmTicketPrompt({ n: 1, title: 'x' }, 'GT', 'GT-0001', {}), devTicketPrompt(T, 'jenny'), qcTicketPrompt(T, 'abc', 'elon')]) expect(p).not.toContain('Chuẩn bắt buộc');
  });
});
