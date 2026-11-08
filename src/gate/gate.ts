import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TaskCard } from '../task/card.ts';
import { changedFiles } from '../git.ts';

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

function matchesScopeItem(file: string, item: string): boolean {
  if (item.endsWith('/')) {
    return file.startsWith(item);
  }
  return file === item;
}

export function outsideScope(changed: string[], scope: string[]): string[] {
  const bad = changed.filter((file) => !scope.some((s) => matchesScopeItem(file, s)));
  return Array.from(new Set(bad));
}

export function runGate(
  repo: string,
  card: TaskCard,
  base: string,
  cmds: { build: string; lint: string; test: string }
): GateResult {
  const reasons: string[] = [];

  // 1. diff base..HEAD rỗng → empty_diff
  const changed = changedFiles(repo, base);
  if (changed.length === 0) {
    reasons.push('empty_diff');
  }

  // 2. file ngoài scope (luôn cho phép team/reports/) → out_of_scope:<file>
  const allowedScope = [...card.scope, 'team/reports/'];
  const outFiles = outsideScope(changed, allowedScope);
  for (const file of outFiles) {
    reasons.push(`out_of_scope:${file}`);
  }

  // 3. thiếu team/reports/<id>-dev.md → missing_report
  const reportPath = join(repo, 'team', 'reports', `${card.id}-dev.md`);
  let hasReport = false;
  try {
    hasReport = existsSync(reportPath) && statSync(reportPath).isFile();
  } catch {
    hasReport = false;
  }
  if (!hasReport) {
    reasons.push('missing_report');
  }

  // 4. mỗi lệnh build/lint/test không rỗng chạy bằng sh -c trong repo, exit ≠ 0 → cmd_failed:<tên>
  const cmdList: Array<['build' | 'lint' | 'test', string | undefined]> = [
    ['build', cmds?.build],
    ['lint', cmds?.lint],
    ['test', cmds?.test],
  ];

  for (const [name, command] of cmdList) {
    if (command && command.trim() !== '') {
      const res = spawnSync('sh', ['-c', command], {
        cwd: repo,
        stdio: 'ignore',
      });
      if (res.status !== 0 || res.error) {
        reasons.push(`cmd_failed:${name}`);
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
