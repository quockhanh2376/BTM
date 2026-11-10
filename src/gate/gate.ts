import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Ticket } from '../ticket/ticket.ts';
import { changedFiles, git } from '../git.ts';
import type { Config } from '../config.ts';
import { workerKillAll, wrapForWorker } from '../isolation/worker.ts';

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export interface GateOptions {
  timeoutMs?: number;
  require_report_schema?: boolean;
  cfg?: Config;
  killAll?: (cfg: Config) => void;
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

export function commitsMissingTicketId(repo: string, base: string, id: string): string[] {
  const out = git(repo, 'log', '--format=%H%x00%s', `${base}..HEAD`);
  if (!out || !out.trim()) {
    return [];
  }

  const expectedPrefix = `${id}: `;
  const missing: string[] = [];

  const lines = out.trim().split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const nullIdx = line.indexOf('\0');
    if (nullIdx === -1) continue;
    const sha = line.slice(0, nullIdx);
    const subject = line.slice(nullIdx + 1);
    if (!subject.startsWith(expectedPrefix)) {
      missing.push(sha);
    }
  }

  return missing;
}

export function reportHeaderOk(repo: string, t: Ticket): boolean {
  const reportPath = join(repo, 'team', 'reports', `${t.id}-dev.md`);
  if (!existsSync(reportPath)) {
    return false;
  }

  let content: string;
  try {
    content = readFileSync(reportPath, 'utf8');
  } catch {
    return false;
  }

  const lines = content.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim().length > 0);
  if (!firstNonEmpty) {
    return false;
  }

  const expectedPrefix = `${t.id} · ${t.goal}#${t.number}/${t.of} · `;
  return firstNonEmpty.trimStart().startsWith(expectedPrefix);
}

export function runGate(
  repo: string,
  ticket: Ticket,
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

  // 1b. mọi thay đổi trong team/tickets/ từ base..HEAD → ticket_tampered (kể cả khi scope có liệt kê)
  if (changed.some((file) => file.startsWith('team/tickets/'))) {
    reasons.push('ticket_tampered');
  }

  // 2. file ngoài scope (luôn cho phép team/reports/) → out_of_scope:<file>
  const allowedScope = [...ticket.scope, 'team/reports/'];
  const outFiles = outsideScope(changed, allowedScope);
  for (const file of outFiles) {
    reasons.push(`out_of_scope:${file}`);
  }

  // 3. thiếu team/reports/<id>-dev.md → missing_report
  const reportPath = join(repo, 'team', 'reports', `${ticket.id}-dev.md`);
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
      const headerOk = reportHeaderOk(repo, ticket);
      const bodyLines = headerOk ? lines.slice(1) : lines;
      if (bodyLines.length > 5) {
        reasons.push('report_too_long');
      }
      if (requireReportSchema) {
        if (!headerOk) {
          reasons.push('report_header_invalid');
        }
        const trimmed = content.trim();
        const isOk = trimmed === 'OK' || /(?:^|\n)\s*OK\s*$/.test(trimmed);
        const hasValidHeading = /(?:^|\n)(?:##\s+(?:Bug|Cần sửa|Cần xác nhận)|#\s+Báo cáo Dev|-\s+(?:Bug|Cần sửa|Cần xác nhận):)/m.test(content);
        if (!isOk && !hasValidHeading) {
          reasons.push('bad_report');
        }
      }
    } catch {
      reasons.push('bad_report');
    }
  }

  if (requireReportSchema) {
    const missingCommits = commitsMissingTicketId(repo, base, ticket.id);
    if (missingCommits.length > 0) {
      reasons.push('commit_missing_ticket_id');
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
      let res: ReturnType<typeof spawnSync>;
      try {
        const argv = optsOrTimeout && typeof optsOrTimeout === 'object' && optsOrTimeout.cfg
          ? wrapForWorker(optsOrTimeout.cfg, ['sh', '-c', command], repo)
          : ['sh', '-c', command];
        res = spawnSync(argv[0], argv.slice(1), {
          cwd: repo,
          stdio: 'ignore',
          timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
        });
      } finally {
        if (optsOrTimeout && typeof optsOrTimeout === 'object' && optsOrTimeout.cfg) {
          (optsOrTimeout.killAll ?? workerKillAll)(optsOrTimeout.cfg);
        }
      }
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
