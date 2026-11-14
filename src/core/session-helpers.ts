// Hàm hỗ trợ của session.ts (tách 2026-11-14, docs/engineering-rules.md). Không đổi hành vi.
import { realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, readdirSync } from 'node:fs';
import { relative, isAbsolute, join, basename } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { checkForbiddenEnv } from '../config.ts';
import { effectiveSeats, readProjectSeats, type Store, type TurnResult } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { loadTickets, checkReady, type Ticket, type TicketState, TicketError } from '../ticket/ticket.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { runGate } from '../gate/gate.ts';
import { detectUsageLimit, usageLimitedKey } from '../agents/usage-limit.ts';
import { accountLastKey, isUsable, pickAccount, seatOpts, slugOfKey, soonestReset, toolOfAccountKey, usableAccounts } from '../agents/accounts.ts';
import { READ_ONLY_SEATS } from '../runner/argv.ts';
import { notify as sendNotify, type NotifyEvent } from '../notify/notify.ts';
import { formatHHmm } from '../energy/monitor.ts';
import { git, commitAll, headSha } from '../git.ts';
import { parseTicketQcResult } from '../qc/result.ts';
import { parseReportQuestions, cleanConfirmItems } from '../qc/questions.ts';
import { parseAuditResult } from '../audit/result.ts';
import { pmTicketPrompt, devTicketPrompt, qcTicketPrompt, auditPrompt } from './prompts.ts';
import { inboxPath, answerImagePath } from '../server/inbox.ts';
import {
  type TurnGuardSnapshot,
  type GuardTurnResult,
  snapshotTurn,
  guardAgentTurn,
  guardStoredAgentTurn,
  recoverInterruptedTurn,
  protectedShaKey,
} from './guard.ts';

import type { SessionDeps, SessionOutcome } from './session.ts';

export function isInside(repo: string, root: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(repo));
    return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

// Cách ly: project của store là checkout tin cậy dưới host.trusted_root.
export function isRepoInsideProjectsRoot(repo: string, cfg: Config): boolean {
  return isInside(repo, cfg.host.projects_root) || Boolean(cfg.host.worker_prefix && cfg.host.trusted_root && isInside(repo, cfg.host.trusted_root));
}

export function isOutOfTurns(store: Store, sessionId: number, cfg: Config, seat: Seat): boolean {
  const seatTurns = store.countTurns(sessionId, seat);
  if (seatTurns >= cfg.session.max_turns_per_seat[seat]) {
    return true;
  }
  const totalTurns = store.countTurns(sessionId);
  const maxTotal =
    seat === 'pm'
      ? cfg.session.max_turns
      : Math.max(0, cfg.session.max_turns - cfg.energy.reserve_turns_for_pm);
  if (totalTurns >= maxTotal) {
    return true;
  }
  return false;
}

export function getWorkingTreeChanges(repo: string): string[] {
  const out = git(repo, 'status', '--porcelain', '-z', '-uall');
  if (!out) return [];
  const tokens = out.split('\0');
  const files: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const item = tokens[i];
    if (!item) {
      i++;
      continue;
    }
    const status = item.slice(0, 2);
    const path = item.slice(3);
    if (path) files.push(path);
    if (status.startsWith('R') || status.startsWith('C')) {
      i++;
      const orig = tokens[i];
      if (orig) files.push(orig);
    }
    i++;
  }
  return files;
}

export function authorForAgent(agentId: string): { name: string; email: string } {
  return {
    name: agentId,
    email: `${agentId}@btm.local`,
  };
}

export function parseTicketIdNumber(id: string, key: string): number {
  const parts = id.split('-');
  return parts.length === 2 && parts[0] === key ? parseInt(parts[1], 10) : NaN;
}

export function hasInvalidDependsOn(
  ticketsToValidate: Ticket[],
  allTicketsInGoal: Ticket[],
  goalStr: string,
  key: string
): boolean {
  const byId = new Map<string, Ticket>();
  for (const t of allTicketsInGoal) {
    if (t.goal === goalStr) {
      byId.set(t.id, t);
    }
  }
  for (const t of ticketsToValidate) {
    const tIdNum = parseTicketIdNumber(t.id, key);
    for (const depId of t.depends_on) {
      const dep = byId.get(depId);
      if (!dep || dep.goal !== goalStr) {
        return true;
      }
      const depIdNum = parseTicketIdNumber(dep.id, key);
      if (isNaN(depIdNum) || isNaN(tIdNum) || depIdNum >= tIdNum || dep.number >= t.number) {
        return true;
      }
    }
  }
  return false;
}

export function writeGoalSummaryAndCommit(
  repo: string,
  goal: { n: number; title: string },
  tickets: Ticket[],
  store: Store
): void {
  const goalsDir = join(repo, 'team', 'goals');
  mkdirSync(goalsDir, { recursive: true });
  const summaryLines = [
    `# G${goal.n} · ${goal.title}`,
    '',
    '| # | Ticket | Title | State | Fix rounds |',
    '|---|---|---|---|---|',
  ];
  for (const t of tickets) {
    const s = store.getTicketState(repo, t.id);
    const state = s?.state ?? 'passed';
    const rounds = s?.fix_rounds ?? 0;
    summaryLines.push(`| ${t.number} | ${t.id} | ${t.title} | ${state} | ${rounds} |`);
  }
  summaryLines.push('');
  const summaryPath = join(goalsDir, `G${goal.n}.md`);
  writeFileSync(summaryPath, summaryLines.join('\n'), 'utf8');

  const coreAuthor = { name: 'core', email: 'core@btm.local' };
  commitAll(repo, `G${goal.n}: summary`, coreAuthor);
}

export function closeNoteIfEligible(
  d: SessionDeps,
  sessionId: number,
  tickets: Ticket[],
  tasks: Record<string, TicketState>,
  outcome: SessionOutcome
): void {
  const sessionNotes = d.store.getNotesBySession(sessionId);
  if (sessionNotes.length === 0) return;

  for (const note of sessionNotes) {
    if (note.status === 'done') continue;
    const ticketsForNote = tickets.filter(
      (t) => t.note === `N-${note.id}` || t.note === String(note.id)
    );
    const allPassed =
      ticketsForNote.length > 0 &&
      ticketsForNote.every((t) => tasks[t.id] === 'passed');

    if (outcome.status === 'done' && allPassed) {
      let notePath: string;
      try {
        notePath = inboxPath(d.repo, `N-${note.id}.md`);
      } catch (err: any) {
        outcome.status = 'needs_owner';
        outcome.notes.push(`inboxPath error: ${err?.message || String(err)}`);
        continue;
      }

      try {
        if (!existsSync(notePath)) {
          throw new Error(`Note file not found: ${notePath}`);
        }
        const content = readFileSync(notePath, 'utf8');
        const updated = content.replace(/^status:\s*open$/m, 'status: done');
        writeFileSync(notePath, updated, 'utf8');
        try {
          commitAll(d.repo, `close note N-${note.id}`, {
            name: 'owner',
            email: 'owner@btm.local',
          });
          d.store.setNoteStatus(note.id, 'done');
        } catch (commitErr: any) {
          try {
            git(d.repo, 'checkout', 'HEAD', '--', notePath);
            git(d.repo, 'reset', 'HEAD', '--', notePath);
          } catch {}
          throw commitErr;
        }
      } catch (err: any) {
        outcome.status = 'needs_owner';
        outcome.notes.push(`close note N-${note.id} error: ${err?.message || String(err)}`);
      }
    } else if (outcome.status === 'done' && !allPassed) {
      outcome.status = 'needs_owner';
    }
  }
}

export interface RecordedTickets {
  files: Set<string>;
  contents: Map<string, string>;
}



export function recordExistingTickets(repo: string): RecordedTickets {
  const ticketsDir = join(repo, 'team', 'tickets');
  const files = new Set<string>();
  const contents = new Map<string, string>();
  if (existsSync(ticketsDir)) {
    for (const f of readdirSync(ticketsDir)) {
      if (f.endsWith('.md')) {
        files.add(f);
        try {
          contents.set(f, readFileSync(join(ticketsDir, f), 'utf8'));
        } catch {}
      }
    }
  }
  try {
    const treeOut = git(repo, 'ls-files', 'team/tickets');
    for (const f of treeOut.split(/\r?\n/).filter(Boolean)) {
      const b = basename(f);
      files.add(b);
      const full = join(repo, f);
      if (existsSync(full) && !contents.has(b)) {
        try {
          contents.set(b, readFileSync(full, 'utf8'));
        } catch {}
      }
    }
  } catch {}
  return { files, contents };
}

export function restoreExistingTickets(repo: string, recorded: RecordedTickets): void {
  const ticketsDir = join(repo, 'team', 'tickets');
  try {
    git(repo, 'reset', 'HEAD', '--', 'team/tickets');
  } catch {}
  try {
    git(repo, 'checkout', 'HEAD', '--', 'team/tickets');
  } catch {}
  for (const [f, content] of recorded.contents.entries()) {
    try {
      writeFileSync(join(ticketsDir, f), content, 'utf8');
    } catch {}
  }
  if (existsSync(ticketsDir)) {
    for (const f of readdirSync(ticketsDir)) {
      if (!recorded.files.has(f)) {
        try {
          rmSync(join(ticketsDir, f), { force: true });
        } catch {}
      }
    }
  }
}

export function cleanupPmWorkingTree(repo: string, recorded: RecordedTickets, prePmStatus?: Set<string>): void {
  restoreExistingTickets(repo, recorded);
  if (prePmStatus) {
    const postPmStatus = getWorkingTreeChanges(repo);
    for (const f of postPmStatus) {
      if (!prePmStatus.has(f)) {
        try {
          git(repo, 'reset', 'HEAD', '--', f);
        } catch {}
        try {
          git(repo, 'checkout', 'HEAD', '--', f);
        } catch {
          try {
            rmSync(join(repo, f), { force: true, recursive: true });
          } catch {}
        }
      }
    }
  }
}

export function restoreTicketFilesFromBase(repo: string, base: string): void {
  const changedTickets = getWorkingTreeChanges(repo).filter((f) => f.startsWith('team/tickets/'));
  if (changedTickets.length === 0) {
    return;
  }

  const baseFiles = new Set(
    git(repo, 'ls-tree', '-r', '--name-only', base, 'team/tickets')
      .split(/\r?\n/)
      .filter(Boolean)
  );
  git(repo, 'reset', base, '--', 'team/tickets');
  if (baseFiles.size > 0) {
    git(repo, 'checkout', base, '--', 'team/tickets');
  }
  for (const file of changedTickets) {
    if (!baseFiles.has(file)) {
      try {
        rmSync(join(repo, file), { force: true });
      } catch {}
    }
  }
}

export function pmModifiedExistingTickets(repo: string, recorded: RecordedTickets): boolean {
  const ticketsDir = join(repo, 'team', 'tickets');
  for (const [f, oldContent] of recorded.contents.entries()) {
    const full = join(ticketsDir, f);
    if (!existsSync(full)) {
      return true;
    }
    try {
      const newContent = readFileSync(full, 'utf8');
      if (newContent !== oldContent) {
        return true;
      }
    } catch {
      return true;
    }
  }
  for (const f of recorded.files) {
    if (!existsSync(join(ticketsDir, f))) {
      return true;
    }
  }
  return false;
}

export function readReport(path: string): string {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size <= 64_000 ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

// Plan 6 Task 2: CLI báo hết hạn mức → ghi agent hết tới giờ hồi (pickSeatAgent bỏ qua agent đó), kết thúc lượt
// bằng lỗi usage_limit_hit:<agent>; host tự Tiếp tục để người dự phòng ngồi thay.
// Plan 7: chọn tài khoản cho lượt (tài khoản pickSeatAgent đã qua gate, nếu còn dùng được; không thì tài khoản đầu tiên
// dùng được), chạy dưới user của tài khoản đó, đánh dấu giới hạn theo tài khoản. Đổi tài khoản so với lượt trước → ntfy.
export function withUsageLimit(d: SessionDeps): SessionDeps {
  const run = d.runner;
  const chosen = d.chosenAccounts ?? new Map<string, string>();
  const send = d.notify ?? ((ev: NotifyEvent) => void sendNotify(d.cfg, ev));
  return {
    ...d,
    chosenAccounts: chosen,
    runner: async (seat, agentId, prompt, cwd, logFile, options) => {
      const pre = chosen.get(agentId);
      chosen.delete(agentId);
      const preTool = pre ? toolOfAccountKey(d.cfg, d.store, pre) : null;
      const opts = seatOpts(d.cfg, d.store, seat, d.repo);
      const key = pre && isUsable(d.store, pre, new Date()) && !(opts.avoidTool && preTool === opts.avoidTool) ? pre : pickAccount(d.cfg, d.store, agentId, new Date(), opts)?.key;
      if (!key) throw new Error(soonestReset(d.store, agentId) ? `usage_limit_hit:${agentId}` : `no_usable_account:${agentId}`);
      const prev = d.store.getSetting(accountLastKey(agentId));
      if (prev && prev !== key) {
        send({ kind: 'account_switch', project: d.repo, notes: [`${agentId}:${slugOfKey(agentId, prev)}_to_${slugOfKey(agentId, key)}`] });
      }
      d.store.setSetting(accountLastKey(agentId), key);
      const out = await run(seat, agentId, prompt, cwd, logFile, { ...options, account: key });
      const tool = toolOfAccountKey(d.cfg, d.store, key) ?? d.cfg.agents[agentId]?.tool;
      const hit = tool ? detectUsageLimit(tool, out, new Date()) : null;
      if (hit) {
        d.store.setSetting(usageLimitedKey(key), hit.resetsAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString());
        throw new Error(`usage_limit_hit:${agentId}`);
      }
      return out;
    },
  };
}

