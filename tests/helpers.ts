import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const AUTHOR = ['-c', 'user.name=test', '-c', 'user.email=test@btm.local'];

export function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'btm-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', [...AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

/** Mã dashboard đầy đủ cho test (2026-11-14: index.html tách ra web/app/*): khung trang + CSS + i18n + logic, đúng thứ tự tải. */
export function readWeb(): string {
  return ['web/index.html', 'web/app/app.css', 'web/app/i18n.js', 'web/app/chat-lines.js', 'web/app/chat-lib.js',
    'web/app/folders.js', 'web/app/goals.js', 'web/app/meeting.js', 'web/app/chat-bubbles.js', 'web/app/accounts.js', 'web/app/app.js']
    .map((f) => readFileSync(resolve(process.cwd(), f), 'utf-8')).join(String.fromCharCode(10));
}
