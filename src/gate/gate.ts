import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TaskCard } from '../task/card.ts';
import { changedFiles } from '../git.ts';

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export interface GateOptions {
  timeoutMs?: number;
  require_report_schema?: boolean;
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
  cmds: { build: string; lint: string; test: string },
  optsOrTimeout?: number | GateOptions,
  extraOpts?: GateOptions
): GateResult {
  let timeoutMs = 0;
  let requireReportSchema = true;

  if (typeof optsOrTimeout === 'number') {
    timeoutMs = optsOrTimeout;
    if (extraOpts?.require_report_schema !== undefined) {
      requireReportSchema = extraOpts.require_report_schema;
    }
  } else if (optsOrTimeout && typeof optsOrTimeout === 'object') {
    if (typeof optsOrTimeout.timeoutMs === 'number') {
      timeoutMs = optsOrTimeout.timeoutMs;
    }
    if (typeof optsOrTimeout.require_report_schema === 'boolean') {
      requireReportSchema = optsOrTimeout.require_report_schema;
    }
  }

  const reasons: string[] = [];

  // 1. diff base..HEAD rỗng (không tính file trong team/reports/) → empty_diff
  const changed = changedFiles(repo, base);
  const nonReportChanged = changed.filter((file) => !file.startsWith('team/reports/'));
  if (nonReportChanged.length === 0) {
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
  } else {
    try {
      const content = readFileSync(reportPath, 'utf8');
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 5) {
        reasons.push('report_too_long');
      }
      if (requireReportSchema) {
        const trimmed = content.trim();
        const isOk = trimmed === 'OK';
        const hasValidHeading = /(?:^|\n)(?:##\s+(?:Bug|Cần sửa|Cần xác nhận)|#\s+Báo cáo Dev|-\s+(?:Bug|Cần sửa|Cần xác nhận):)/m.test(content);
        if (!isOk && !hasValidHeading) {
          reasons.push('bad_report');
        }
      }
    } catch {
      reasons.push('bad_report');
    }
  }

  // 4. mỗi lệnh build/lint/test không rỗng chạy bằng sh -c trong repo, exit ≠ 0 → cmd_failed:<tên>; quá giờ → cmd_timeout:<tên>
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
        timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
      });
      if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        reasons.push(`cmd_timeout:${name}`);
      } else if (res.status !== 0 || res.error) {
        reasons.push(`cmd_failed:${name}`);
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
  };
}
