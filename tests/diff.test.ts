import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUnifiedDiff, ticketDiff } from '../src/server/diff.ts';
import { parseReportQuestions } from '../src/qc/questions.ts';
import { tmpRepo } from './helpers.ts';

describe('P6-T3: diff ticket', () => {
  it('parse: file, hunk, số dòng mới/cũ, file nhị phân, bỏ dòng "\ No newline"', () => {
    const text = [
      'diff --git a/src/a b.ts b/src/a b.ts',
      'index 1..2 100644',
      '--- a/src/a b.ts',
      '+++ b/src/a b.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '+more',
      String.raw`\ No newline at end of file`,
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');
    const d = parseUnifiedDiff(text);
    expect(d.truncated).toBe(false);
    expect(d.files.map((f) => f.path)).toEqual(['src/a b.ts', 'img.png']);
    expect(d.files[1]!.binary).toBe(true);
    expect(d.files[0]!.hunks[0]!.lines).toEqual([
      { kind: ' ', text: 'keep', oldLine: 1, newLine: 1 },
      { kind: '-', text: 'old', oldLine: 2 },
      { kind: '+', text: 'new', newLine: 2 },
      { kind: '+', text: 'more', newLine: 3 },
    ]);
    expect(parseUnifiedDiff(text, 2).truncated).toBe(true);
  });

  it('ticketDiff trên repo thật: base..nhánh goal; base không phải sha / nhánh lạ → lỗi', () => {
    const repo = tmpRepo({ 'src/app.ts': 'export const a = 1;\n' });
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-qb', 'goal/G1-x');
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const a = 2;\n');
    g('commit', '-qam', 'GTM-0001: x');
    const d = ticketDiff(repo, base, 'goal/G1-x');
    expect(d.files[0]!.path).toBe('src/app.ts');
    expect(d.files[0]!.hunks[0]!.lines.map((l) => l.kind + l.text)).toEqual(['-export const a = 1;', '+export const a = 2;']);
    expect(() => ticketDiff(repo, 'HEAD; rm', 'goal/G1-x')).toThrow('bad base');
    expect(() => ticketDiff(repo, base, '--output=/tmp/x')).toThrow('bad branch');
  });
});

describe('P6-T4: câu hỏi trong báo cáo Dev', () => {
  it('dòng "Cần xác nhận:" và gạch đầu dòng dưới heading; tối đa 5, cắt 500, bỏ ký tự điều khiển', () => {
    const md = [
      'GTM-0001 · G1#1/1 · Jacky-Dev',
      '- Bug: none',
      '- Cần xác nhận: Có đổi tên API /v1 không?',
      '## Cần xác nhận',
      '- Dùng PostgreSQL hay SQLite?',
      '- Bỏ\u0007 hỗ trợ IE?',
      '## Bug',
      '- không phải câu hỏi',
    ].join('\n');
    expect(parseReportQuestions(md)).toEqual(['Có đổi tên API /v1 không?', 'Dùng PostgreSQL hay SQLite?', 'Bỏ  hỗ trợ IE?']);
    expect(parseReportQuestions('OK')).toEqual([]);
    expect(parseReportQuestions('- Cần xác nhận: OK\n- Cần xác nhận: không\nCần xác nhận: none')).toEqual([]);
    expect(parseReportQuestions(Array.from({ length: 9 }, (_, i) => `Cần xác nhận: q${i}`).join('\n'))).toHaveLength(5);
  });
});
