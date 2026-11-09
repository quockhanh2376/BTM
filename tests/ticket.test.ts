import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTicket,
  loadTickets,
  checkReady,
  reportHeader,
  TicketError,
  type Ticket,
  type TicketState,
} from '../src/ticket/ticket.ts';
import { slugify, goalBranch } from '../src/ticket/goal.ts';

describe('Ticket – schema, parser, DoR', () => {
  const sampleTicketMd = `---
id: GTM-0012
goal: G1
number: 3
of: 9
title: "Form reset mật khẩu: gửi email chứa link có hạn 15 phút"
type: feat
size: M
depends_on: [GTM-0010]
scope: [src/auth/reset.ts, tests/auth/reset.test.ts]
acceptance:
  - "Email hợp lệ → gửi link, link hết hạn sau 15 phút"
  - "Email không tồn tại → vẫn trả thông báo chung (không lộ tài khoản)"
done_when: "Test mới cho cả 2 tiêu chí đều pass"
note: N-4
from_audit: false
---
# GTM-0012 Details
Body text here...
`;

  it('ticket mẫu ở docs/tickets.md §3 parse đúng, có đủ các trường', () => {
    const t = parseTicket(sampleTicketMd, 'GTM');
    expect(t.id).toBe('GTM-0012');
    expect(t.goal).toBe('G1');
    expect(t.number).toBe(3);
    expect(t.of).toBe(9);
    expect(t.title).toBe('Form reset mật khẩu: gửi email chứa link có hạn 15 phút');
    expect(t.type).toBe('feat');
    expect(t.size).toBe('M');
    expect(t.depends_on).toEqual(['GTM-0010']);
    expect(t.scope).toEqual(['src/auth/reset.ts', 'tests/auth/reset.test.ts']);
    expect(t.acceptance).toHaveLength(2);
    expect(t.acceptance[0]).toContain('Email hợp lệ');
    expect(t.done_when).toBe('Test mới cho cả 2 tiêu chí đều pass');
    expect(t.note).toBe('N-4');
    expect(t.from_audit).toBe(false);
  });

  it('depends_on mặc định [] và from_audit mặc định false khi không truyền', () => {
    const md = `---
id: GTM-0001
goal: G1
number: 1
of: 1
title: "Initial feature"
type: chore
size: S
scope: [src/index.ts]
acceptance:
  - "Runs fine"
done_when: "Passes"
---
`;
    const t = parseTicket(md, 'GTM');
    expect(t.depends_on).toEqual([]);
    expect(t.from_audit).toBe(false);
  });

  it('id: XYZ-0001 khi key GTM → ném TicketError', () => {
    const md = sampleTicketMd.replace('id: GTM-0012', 'id: XYZ-0001');
    expect(() => parseTicket(md, 'GTM')).toThrow(TicketError);
  });

  it('number: 10, of: 9 → ném TicketError', () => {
    const md = sampleTicketMd.replace('number: 3', 'number: 10');
    expect(() => parseTicket(md, 'GTM')).toThrow(TicketError);
  });

  it('acceptance 0 hoặc 6 mục → ném TicketError', () => {
    const md0 = sampleTicketMd.replace(
      /acceptance:[\s\S]*?done_when:/,
      'acceptance: []\ndone_when:'
    );
    expect(() => parseTicket(md0, 'GTM')).toThrow(TicketError);

    const md6 = sampleTicketMd.replace(
      /acceptance:[\s\S]*?done_when:/,
      `acceptance:\n  - a\n  - b\n  - c\n  - d\n  - e\n  - f\ndone_when:`
    );
    expect(() => parseTicket(md6, 'GTM')).toThrow(TicketError);
  });

  it('type: bug → ném TicketError (chỉ feat|fix|chore|security)', () => {
    const md = sampleTicketMd.replace('type: feat', 'type: bug');
    expect(() => parseTicket(md, 'GTM')).toThrow(TicketError);
  });

  it('size: XL → ném TicketError (chỉ S|M|L)', () => {
    const md = sampleTicketMd.replace('size: M', 'size: XL');
    expect(() => parseTicket(md, 'GTM')).toThrow(TicketError);
  });

  it('scope ../x → ném TicketError (luật ScopePathSchema)', () => {
    const md = sampleTicketMd.replace('src/auth/reset.ts', '../outside.ts');
    expect(() => parseTicket(md, 'GTM')).toThrow(TicketError);
  });

  it('thiếu front matter hoặc YAML lỗi → ném TicketError', () => {
    expect(() => parseTicket('No front matter here', 'GTM')).toThrow(TicketError);
    expect(() => parseTicket('---\n: invalid yaml :\n---\n', 'GTM')).toThrow(TicketError);
  });
});

describe('loadTickets', () => {
  it('đọc team/tickets/*.md, sắp xếp theo goal rồi number và lọc theo goal', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'btm-tickets-test-'));
    const ticketsDir = join(tmp, 'team', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });

    const makeTicket = (id: string, goal: string, num: number, of: number) => `---
id: ${id}
goal: ${goal}
number: ${num}
of: ${of}
title: "Ticket ${id}"
type: feat
size: S
scope: [src/a.ts]
acceptance:
  - "ok"
done_when: "ok"
---
`;

    writeFileSync(join(ticketsDir, 'GTM-0003.md'), makeTicket('GTM-0003', 'G2', 1, 1));
    writeFileSync(join(ticketsDir, 'GTM-0002.md'), makeTicket('GTM-0002', 'G1', 2, 2));
    writeFileSync(join(ticketsDir, 'GTM-0001.md'), makeTicket('GTM-0001', 'G1', 1, 2));

    const all = loadTickets(tmp, 'GTM');
    expect(all.map((t) => t.id)).toEqual(['GTM-0001', 'GTM-0002', 'GTM-0003']);

    const g1Only = loadTickets(tmp, 'GTM', 'G1');
    expect(g1Only.map((t) => t.id)).toEqual(['GTM-0001', 'GTM-0002']);

    const g2Only = loadTickets(tmp, 'GTM', 'G2');
    expect(g2Only.map((t) => t.id)).toEqual(['GTM-0003']);
  });

  it('2 file cùng G1 number 3 → ném TicketError duplicate number', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'btm-tickets-dupnum-'));
    const ticketsDir = join(tmp, 'team', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });

    const makeTicket = (id: string, goal: string, num: number) => `---
id: ${id}
goal: ${goal}
number: ${num}
of: 5
title: "Ticket ${id}"
type: feat
size: S
scope: [src/a.ts]
acceptance:
  - "ok"
done_when: "ok"
---
`;

    writeFileSync(join(ticketsDir, 'GTM-0001.md'), makeTicket('GTM-0001', 'G1', 3));
    writeFileSync(join(ticketsDir, 'GTM-0002.md'), makeTicket('GTM-0002', 'G1', 3));

    expect(() => loadTickets(tmp, 'GTM')).toThrow(/duplicate.*number/i);
  });

  it('2 file cùng id → ném TicketError', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'btm-tickets-dupid-'));
    const ticketsDir = join(tmp, 'team', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });

    // Filename mismatch or duplicate
    writeFileSync(
      join(ticketsDir, 'GTM-0001.md'),
      `---
id: GTM-0001
goal: G1
number: 1
of: 2
title: "Ticket 1"
type: feat
size: S
scope: [src/a.ts]
acceptance:
  - "ok"
done_when: "ok"
---
`
    );
    writeFileSync(
      join(ticketsDir, 'other.md'),
      `---
id: GTM-0001
goal: G1
number: 2
of: 2
title: "Ticket 2"
type: feat
size: S
scope: [src/a.ts]
acceptance:
  - "ok"
done_when: "ok"
---
`
    );

    expect(() => loadTickets(tmp, 'GTM')).toThrow(TicketError);
  });

  it('bỏ qua symlink trong team/tickets/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'btm-tickets-symlink-'));
    const ticketsDir = join(tmp, 'team', 'tickets');
    mkdirSync(ticketsDir, { recursive: true });

    writeFileSync(
      join(ticketsDir, 'GTM-0001.md'),
      `---
id: GTM-0001
goal: G1
number: 1
of: 1
title: "Ticket 1"
type: feat
size: S
scope: [src/a.ts]
acceptance:
  - "ok"
done_when: "ok"
---
`
    );

    try {
      symlinkSync(join(ticketsDir, 'GTM-0001.md'), join(ticketsDir, 'GTM-0002.md'));
    } catch {
      // Ignore if symlink creation is not permitted on Windows
    }

    const tickets = loadTickets(tmp, 'GTM');
    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe('GTM-0001');
  });
});

describe('checkReady (Definition of Ready)', () => {
  const baseTicket: Ticket = {
    id: 'GTM-0012',
    goal: 'G1',
    number: 3,
    of: 9,
    title: 'Reset password form',
    type: 'feat',
    size: 'M',
    scope: ['src/a.ts'],
    acceptance: ['ok'],
    done_when: 'ok',
    depends_on: ['GTM-0010'],
    from_audit: false,
  };

  it('size L → [size_L]', () => {
    const t: Ticket = { ...baseTicket, size: 'L', depends_on: [] };
    const reasons = checkReady(t, () => null);
    expect(reasons).toEqual(['size_L']);
  });

  it('depends_on chưa passed → [depends_on:GTM-0010]', () => {
    const t: Ticket = { ...baseTicket, size: 'M', depends_on: ['GTM-0010'] };
    const reasons1 = checkReady(t, (id) => (id === 'GTM-0010' ? 'pending' : null));
    expect(reasons1).toEqual(['depends_on:GTM-0010']);

    const reasons2 = checkReady(t, () => null);
    expect(reasons2).toEqual(['depends_on:GTM-0010']);
  });

  it('đủ điều kiện (size ≠ L và mọi depends_on đã passed) → []', () => {
    const t: Ticket = { ...baseTicket, size: 'S', depends_on: ['GTM-0010'] };
    const reasons = checkReady(t, (id) => (id === 'GTM-0010' ? 'passed' : null));
    expect(reasons).toEqual([]);
  });
});

describe('reportHeader', () => {
  const t: Ticket = {
    id: 'GTM-0012',
    goal: 'G1',
    number: 3,
    of: 9,
    title: 'Reset password',
    type: 'feat',
    size: 'M',
    scope: ['src/a.ts'],
    acceptance: ['ok'],
    done_when: 'ok',
    depends_on: [],
    from_audit: false,
  };

  it('tạo đúng dòng mã báo cáo: <ID> · G<n>#<k>/<of> · <Tên>-<Ghế>', () => {
    expect(reportHeader(t, 'Jacky', 'Dev')).toBe('GTM-0012 · G1#3/9 · Jacky-Dev');
    expect(reportHeader(t, 'Jenny', 'QC')).toBe('GTM-0012 · G1#3/9 · Jenny-QC');
    expect(reportHeader(t, 'Kai', 'Audit')).toBe('GTM-0012 · G1#3/9 · Kai-Audit');
  });
});

describe('goalBranch & slugify', () => {
  it('goalBranch(1, "UI đăng nhập + reset pass!!") === "goal/G1-ui-dang-nhap-reset-pass"', () => {
    expect(goalBranch(1, 'UI đăng nhập + reset pass!!')).toBe('goal/G1-ui-dang-nhap-reset-pass');
  });

  it('slugify("!!!") === "goal"', () => {
    expect(slugify('!!!')).toBe('goal');
  });

  it('tiêu đề 80 ký tự → slug ≤ 30, không kết thúc bằng -', () => {
    const longTitle = 'Một tiêu đề rất dài để kiểm tra việc cắt ngắn slug của branch trong hệ thống btm v1';
    const slug = slugify(longTitle);
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('-')).toBe(false);
    expect(/^[a-z0-9-]+$/.test(slug)).toBe(true);
  });
});
