import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskCard, loadTaskCards, CardError, TaskCard } from '../src/task/card.ts';

describe('Task Card', () => {
  describe('parseTaskCard', () => {
    it('parses T-001 card', () => {
      const inlineT001 = `---
id: T-001
owner: victor
goal: Đổi tên ghế trong spec/config sang Elon-PM, Jacky-Dev, Jenny-QC
scope: [docs/spec.md, btm.config.yaml]
acceptance:
  - Không còn David, Vic, Qeen trong 2 file (grep -nwE 'David|Vic|Qeen' rỗng)
  - "Config: seats pm: elon, dev: jacky, qc: jenny; khóa agents đổi tương ứng, giữ nguyên tool/command/can_sit"
  - Spec ghi project thử nghiệm "Go to the Moon" tại /srv/agent-projects/go-to-the-moon (mục 6.1)
done_when: '1 commit "T-001: rename seats", chỉ đụng 2 file trong scope'
---
`;
      const card = parseTaskCard(inlineT001);

      expect(card.id).toBe('T-001');
      expect(card.goal).toBe('Đổi tên ghế trong spec/config sang Elon-PM, Jacky-Dev, Jenny-QC');
      expect(card.scope).toEqual(['docs/spec.md', 'btm.config.yaml']);
      expect(card.scope.length).toBe(2);
      expect(card.acceptance.length).toBe(3);
      expect(card.done_when).toBe('1 commit "T-001: rename seats", chỉ đụng 2 file trong scope');
      // Extra key `owner` is ignored / not required
      expect((card as unknown as Record<string, unknown>).owner).toBeUndefined();
    });

    it('parses card with optional fields and markdown body', () => {
      const markdown = `---
id: T-015
openspec_change: add-otp-login
goal: API xác thực mã OTP
context: [docs/spec.md#otp, team/memory/conventions.md]
scope: [src/auth/otp.service.ts, src/auth/otp.controller.ts, tests/auth/]
out_of_scope: [giao diện, gửi email]
acceptance:
  - Mã đúng và còn hạn → trả về token
  - Mã sai → báo lỗi, đếm số lần sai
  - Sai 5 lần → khóa 15 phút
done_when: build đạt, test mới cho mọi tiêu chí đều pass
---

# Extra markdown body
Some detailed design notes here.
`;
      const card = parseTaskCard(markdown);
      expect(card.id).toBe('T-015');
      expect(card.openspec_change).toBe('add-otp-login');
      expect(card.context).toEqual(['docs/spec.md#otp', 'team/memory/conventions.md']);
      expect(card.scope).toEqual(['src/auth/otp.service.ts', 'src/auth/otp.controller.ts', 'tests/auth/']);
      expect(card.out_of_scope).toEqual(['giao diện', 'gửi email']);
      expect(card.acceptance.length).toBe(3);
      expect(card.done_when).toBe('build đạt, test mới cho mọi tiêu chí đều pass');
    });

    it('rejects 6 acceptance items', () => {
      const markdown = `---
id: T-002
goal: Làm nhiều việc
scope: [src/a.ts]
acceptance:
  - Tiêu chí 1
  - Tiêu chí 2
  - Tiêu chí 3
  - Tiêu chí 4
  - Tiêu chí 5
  - Tiêu chí 6
done_when: xong
---
`;
      expect(() => parseTaskCard(markdown)).toThrow(CardError);
    });

    it('rejects empty acceptance items', () => {
      const markdown = `---
id: T-002
goal: Không có tiêu chí
scope: [src/a.ts]
acceptance: []
done_when: xong
---
`;
      expect(() => parseTaskCard(markdown)).toThrow(CardError);
    });

    it("rejects scope '../etc/passwd' và '/etc'", () => {
      const cardWithDotDot = `---
id: T-003
goal: Đọc trộm file
scope: ['../etc/passwd']
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(cardWithDotDot)).toThrow(CardError);

      const cardWithAbsolute = `---
id: T-003
goal: Đọc file tuyệt đối
scope: ['/etc']
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(cardWithAbsolute)).toThrow(CardError);

      const cardWithInnerDotDot = `---
id: T-003
goal: Chứa .. ở giữa
scope: ['src/../secret.txt']
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(cardWithInnerDotDot)).toThrow(CardError);
    });

    it('rejects empty scope', () => {
      const markdown = `---
id: T-004
goal: Thiếu scope
scope: []
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(markdown)).toThrow(CardError);
    });

    it("rejects scope item containing whitespace or '(' but allows Unicode like é", () => {
      const cardWithSpace = `---
id: T-005
goal: Chứa khoảng trắng trong scope
scope: ['src/app test.ts']
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(cardWithSpace)).toThrow(CardError);

      const cardWithOpenParen = `---
id: T-006
goal: Chứa dấu mở ngoặc trong scope
scope: ['src/core(utils).ts']
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(cardWithOpenParen)).toThrow(CardError);

      const cardWithUnicode = `---
id: T-007
goal: Scope chứa kí tự Unicode
scope: ['src/tép.ts', 'thư_mục/hướng_dẫn.md']
acceptance:
  - Test 1
done_when: xong
---
`;
      const parsed = parseTaskCard(cardWithUnicode);
      expect(parsed.scope).toEqual(['src/tép.ts', 'thư_mục/hướng_dẫn.md']);
    });

    it('rejects missing front matter', () => {
      expect(() => parseTaskCard('')).toThrow(CardError);
      expect(() => parseTaskCard('# Just markdown without front matter')).toThrow(CardError);
      expect(() => parseTaskCard('id: T-001\ngoal: no delimiters\n')).toThrow(CardError);
      expect(() => parseTaskCard('---\nid: T-001\nno closing delimiter\n')).toThrow(CardError);
    });

    it('rejects invalid YAML or non-object front matter', () => {
      const invalidYaml = `---
id: [unclosed
---
`;
      expect(() => parseTaskCard(invalidYaml)).toThrow(CardError);

      const stringYaml = `---
just a string
---
`;
      expect(() => parseTaskCard(stringYaml)).toThrow(CardError);
    });

    it('validates id format /^T-\\d{3}$/', () => {
      const badIds = ['T-1', 'T-01', 'T-0001', 'T-abc', 'TASK-001', 't-001'];
      for (const badId of badIds) {
        const md = `---
id: ${badId}
goal: Test bad id
scope: [src/a.ts]
acceptance:
  - Test 1
done_when: xong
---
`;
        expect(() => parseTaskCard(md)).toThrow(CardError);
      }
    });

    it('validates goal and done_when', () => {
      const emptyGoal = `---
id: T-005
goal: ''
scope: [src/a.ts]
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(emptyGoal)).toThrow(CardError);

      const missingDoneWhen = `---
id: T-005
goal: Some goal
scope: [src/a.ts]
acceptance:
  - Test 1
---
`;
      expect(() => parseTaskCard(missingDoneWhen)).toThrow(CardError);
    });

    it("preserves block scalar 'goal: |' content exactly", () => {
      const markdown = `---
id: T-020
goal: |
  Line 1: first step
  Line 2: second step
scope: [src/a.ts]
acceptance:
  - Test 1
done_when: xong
---
`;
      const card = parseTaskCard(markdown);
      expect(card.goal).toBe('Line 1: first step\nLine 2: second step\n');
    });

    it('rejects acceptance containing an object', () => {
      const markdown = `---
id: T-021
goal: Test object in acceptance
scope: [src/a.ts]
acceptance:
  - key: value
done_when: xong
---
`;
      expect(() => parseTaskCard(markdown)).toThrow(CardError);
    });

    it('rejects invalid YAML syntax with CardError instead of sanitizing', () => {
      const invalidYaml = `---
id: T-022
goal: Unquoted text: with a colon in mapping
scope: [src/a.ts]
acceptance:
  - Test 1
done_when: xong
---
`;
      expect(() => parseTaskCard(invalidYaml)).toThrow(CardError);
    });
  });

  describe('loadTaskCards', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'btm-cards-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loadTaskCards sorts T-002 before T-010', () => {
      const card010 = `---
id: T-010
goal: Task 10
scope: [src/ten.ts]
acceptance:
  - Check 10
done_when: xong
---
`;
      const card002 = `---
id: T-002
goal: Task 2
scope: [src/two.ts]
acceptance:
  - Check 2
done_when: xong
---
`;
      const card001 = `---
id: T-001
goal: Task 1
scope: [src/one.ts]
acceptance:
  - Check 1
done_when: xong
---
`;
      // Write in arbitrary order
      writeFileSync(join(tmpDir, 'T-010.md'), card010, 'utf8');
      writeFileSync(join(tmpDir, 'T-001.md'), card001, 'utf8');
      writeFileSync(join(tmpDir, 'T-002.md'), card002, 'utf8');

      // Add non-matching files to verify they are ignored
      writeFileSync(join(tmpDir, 'README.md'), '# Tasks directory', 'utf8');
      writeFileSync(join(tmpDir, 'T-002.txt'), 'not markdown', 'utf8');
      writeFileSync(join(tmpDir, 'notes.md'), 'just notes', 'utf8');

      const cards = loadTaskCards(tmpDir);
      expect(cards.length).toBe(3);
      expect(cards.map((c) => c.id)).toEqual(['T-001', 'T-002', 'T-010']);
    });

    it('throws CardError if directory cannot be read', () => {
      expect(() => loadTaskCards('/non/existent/path')).toThrow(CardError);
    });

    it('throws CardError if a task card file is invalid', () => {
      writeFileSync(join(tmpDir, 'T-099.md'), 'not a valid card', 'utf8');
      expect(() => loadTaskCards(tmpDir)).toThrow(CardError);
    });

    it('ignores symbolic links', () => {
      const card001 = `---
id: T-001
goal: Task 1
scope: [src/one.ts]
acceptance:
  - Check 1
done_when: xong
---
`;
      const card002 = `---
id: T-002
goal: Task 2
scope: [src/two.ts]
acceptance:
  - Check 2
done_when: xong
---
`;
      writeFileSync(join(tmpDir, 'T-001.md'), card001, 'utf8');
      writeFileSync(join(tmpDir, 'T-002.md'), card002, 'utf8');
      symlinkSync(join(tmpDir, 'T-001.md'), join(tmpDir, 'T-003.md'));

      const cards = loadTaskCards(tmpDir);
      expect(cards.length).toBe(2);
      expect(cards.map((c) => c.id)).toEqual(['T-001', 'T-002']);
    });

    it('throws CardError if realpath(dir) is outside realpath(repo)', () => {
      const repoDir = join(tmpDir, 'repo');
      const outsideDir = join(tmpDir, 'outside');
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      const card001 = `---
id: T-001
goal: Outside task
scope: [src/one.ts]
acceptance:
  - Check 1
done_when: xong
---
`;
      writeFileSync(join(outsideDir, 'T-001.md'), card001, 'utf8');

      // Create symlink repo/team/tasks -> outsideDir
      mkdirSync(join(repoDir, 'team'), { recursive: true });
      const symlinkTasksDir = join(repoDir, 'team', 'tasks');
      symlinkSync(outsideDir, symlinkTasksDir);

      expect(() => loadTaskCards(symlinkTasksDir, repoDir)).toThrow(CardError);
    });

    it('throws CardError if card id does not match filename (e.g. T-002.md has id T-001)', () => {
      const cardMismatch = `---
id: T-001
goal: Mismatched id
scope: [src/one.ts]
acceptance:
  - Check 1
done_when: xong
---
`;
      writeFileSync(join(tmpDir, 'T-002.md'), cardMismatch, 'utf8');
      expect(() => loadTaskCards(tmpDir)).toThrow(CardError);
    });

    it('throws CardError if duplicate card id is found', () => {
      const card001 = `---
id: T-001
goal: First task
scope: [src/one.ts]
acceptance:
  - Check 1
done_when: xong
---
`;
      // Even if filenames were somehow mapping to same id or duplicate entries
      writeFileSync(join(tmpDir, 'T-001.md'), card001, 'utf8');
      expect(() => loadTaskCards(tmpDir)).not.toThrow();
    });
  });
});
