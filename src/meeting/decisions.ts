// Sổ quyết định của project (anh Zon 2026-11-14): mỗi lần anh chốt một cuộc biểu quyết ghi một dòng; PM đọc khi lập ticket.
import { readFileSync } from 'node:fs';
import { decisionsFile } from './core.ts';

export const DECISIONS_PROMPT_MAX = 2000;

/** Dòng quyết định mới nhất trước, tối đa `max` ký tự; chưa có sổ → rỗng. */
export function decisionsForPrompt(dataDir: string, key: string, max = DECISIONS_PROMPT_MAX): string {
  let text = '';
  try { text = readFileSync(decisionsFile(dataDir, key), 'utf8'); } catch { return ''; }
  const out: string[] = [];
  let len = 0;
  for (const l of text.split(/\r?\n/).filter((x) => x.startsWith('- ')).reverse()) {
    if (len + l.length + 1 > max) break;
    out.push(l);
    len += l.length + 1;
  }
  return out.join('\n');
}
