import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
