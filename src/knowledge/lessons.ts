// Bài học sau mỗi goal (anh Zon 2026-11-14): PM (Finn, Boss dự phòng) viết ≤10 bài học sau khi goal được duyệt;
// PM đọc lại khi lập ticket goal sau. File markdown ngoài git, anh sửa được trên dashboard.
// Spec: docs/superpowers/specs/2026-11-14-ticket-trace-lessons-design.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { readProjectKey } from '../ticket/goal.ts';

export const LESSONS_MAX = 10;
export const LESSON_CHARS = 300;
export const LESSONS_KEEP = 30;
export const LESSONS_PROMPT_MAX = 3000;
export const LESSONS_EDIT_MAX = 20000;

const Schema = z.object({ lessons: z.array(z.string()).max(50) }).passthrough();

export const lessonsFile = (dataDir: string, key: string) => join(dataDir, 'knowledge', key, 'lessons.md');
/** File bài học của project; project chưa có team/project.yaml → null. */
export function projectLessonsFile(dataDir: string, project: string): string | null {
  try { return lessonsFile(dataDir, readProjectKey(project)); } catch { return null; }
}
export const sharedLessonsFile = (dataDir: string) => join(dataDir, 'knowledge', 'lessons.md');

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LESSON_CHARS);

/** Khối {"lessons":[…]} cuối cùng trong output agent (không tin cậy) → ≤10 câu đã làm sạch; không có → null. */
export function parseLessons(text: string): string[] | null {
  const s = String(text || '');
  for (let i = s.lastIndexOf('{"lessons"'); i >= 0; i = i > 0 ? s.lastIndexOf('{"lessons"', i - 1) : -1) {
    // Câu bài học có thể chứa '}' → thử từng dấu '}' phía sau tới khi JSON hợp lệ.
    for (let close = s.indexOf('}', i); close >= 0 && close - i < 20000; close = s.indexOf('}', close + 1)) {
      let v: unknown;
      try { v = JSON.parse(s.slice(i, close + 1)); } catch { continue; }
      const parsed = Schema.safeParse(v);
      if (!parsed.success) break;
      const out = parsed.data.lessons.map(clean).filter(Boolean).slice(0, LESSONS_MAX);
      return out.length ? out : null;
    }
  }
  return null;
}

export function readLessons(file: string): string {
  try { return file && existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

export function writeLessons(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text.endsWith('\n') || !text ? text : text + '\n', { mode: 0o600 });
}

/** Thêm `- [tag] bài học`; giữ `keep` dòng bài học mới nhất, các dòng khác (anh tự viết) giữ nguyên. */
export function appendLessons(file: string, tag: string, lessons: string[], keep = LESSONS_KEEP): void {
  const lines = readLessons(file).split(/\r?\n/).filter((l, i, a) => l.trim() || i < a.length - 1);
  for (const l of lessons) lines.push(`- [${tag}] ${clean(l)}`);
  let bullets = lines.filter((l) => l.startsWith('- ')).length;
  const out = lines.filter((l) => (l.startsWith('- ') && bullets > keep ? (bullets--, false) : true));
  writeLessons(file, out.join('\n').trim() + '\n');
}

/** Bài học dán vào prompt PM: của project trước, chung sau, bỏ trùng, tối đa `max` ký tự. */
export function lessonsForPrompt(dataDir: string, key: string, max = LESSONS_PROMPT_MAX): string {
  const seen = new Set<string>();
  const out: string[] = [];
  let len = 0;
  for (const file of [lessonsFile(dataDir, key), sharedLessonsFile(dataDir)]) {
    const bullets = readLessons(file).split(/\r?\n/).filter((l) => l.startsWith('- ')).reverse(); // mới nhất trước
    for (const l of bullets) {
      if (seen.has(l) || len + l.length + 1 > max) continue;
      seen.add(l);
      out.push(l);
      len += l.length + 1;
    }
  }
  return out.join('\n');
}
