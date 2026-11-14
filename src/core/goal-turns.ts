// Các lượt của một goal, tách khỏi processGoal (session.ts) 2026-11-14 – docs/engineering-rules.md.
// Mỗi hàm nhận GoalCtx (trạng thái chung của goal trong phiên), trả SessionOutcome để kết thúc phiên,
// hoặc null / 'again' để processGoal đi tiếp. Code bên trong giữ nguyên, không đổi hành vi.
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
import { accountLastKey, isUsable, pickAccount, slugOfKey, soonestReset, usableAccounts } from '../agents/accounts.ts';
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
import {
  authorForAgent,
  cleanupPmWorkingTree,
  closeNoteIfEligible,
  getWorkingTreeChanges,
  hasInvalidDependsOn,
  isInside,
  isOutOfTurns,
  isRepoInsideProjectsRoot,
  parseTicketIdNumber,
  pmModifiedExistingTickets,
  readReport,
  recordExistingTickets,
  restoreExistingTickets,
  restoreTicketFilesFromBase,
  withUsageLimit,
  writeGoalSummaryAndCommit,
  type RecordedTickets,
} from './session-helpers.ts';

import type { SessionDeps, SessionOutcome, RunSessionOpts } from './session.ts';

export interface GoalCtx {
  d: SessionDeps;
  sessionId: number;
  goal: { n: number; title: string; branch: string };
  key: string;
  tasks: Record<string, TicketState>;
  o: RunSessionOpts;
  attachedNote: ReturnType<SessionDeps['store']['getNote']>;
  baseBranch: string;
  refreshFn: SessionDeps['refresh'];
  gateFn: SessionDeps['gate'];
  /** Agent ngồi ghế PM (đổi khi người chính hết Energy → dự phòng). */
  pmAgent: string;
  pmAuthor: { name: string; email: string };
  ownerAnswers(ticketId: string): string[];
  answerImages(ticketId: string): string[];
  askQuestions(ticketId: string, seat: Seat, agent: string, items: string[]): number;
  backupsFor(seat: Seat): string[];
  pickSeatAgent(seat: Seat, primary: string, exclude?: Set<string>): Promise<{ agent: string } | { agent: null; notes: string[] }>;
}

/** Lượt PM lập ticket cho goal (khi goal chưa có ticket). null = đi tiếp. */
export async function runPmPlanning(ctx: GoalCtx): Promise<SessionOutcome | null> {
  const { d, sessionId, goal, key, tasks, o, attachedNote, baseBranch, refreshFn, gateFn,
    ownerAnswers, answerImages, askQuestions, backupsFor, pickSeatAgent } = ctx;
  void o; void attachedNote; void refreshFn; void gateFn; void baseBranch;
  // 2. Check if tickets exist for this goal
  let existingGoalTickets = loadTickets(d.repo, key, `G${goal.n}`);

  if (existingGoalTickets.length === 0) {
    // PM Turn
    {
      const pick = await pickSeatAgent('pm', ctx.pmAgent);
      if (pick.agent === null) {
        d.store.recordHandoffFailure(sessionId, 'pm', pick.notes[0] ?? 'gate');
        return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
      }
      ctx.pmAgent = pick.agent;
      ctx.pmAuthor = authorForAgent(ctx.pmAgent);
    }

    if (isOutOfTurns(d.store, sessionId, d.cfg, 'pm')) {
      return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns for PM'] };
    }

    const pmTurnId = d.store.startTurn(sessionId, 'pm', ctx.pmAgent, null);
    const pmLogFile = join(d.logDir, `turn-${pmTurnId}.log`);
    d.store.setTurnLog(pmTurnId, pmLogFile);

    let promptNotes: Array<{ notePath: string; imagePath?: string; id?: string }> | undefined;
    if (attachedNote) {
      promptNotes = [
        {
          notePath: `team/inbox/N-${attachedNote.id}.md`,
          imagePath: attachedNote.image ? `team/inbox/${attachedNote.image}` : undefined,
          id: `N-${attachedNote.id}`,
        },
      ];
    }
    const seq = d.store.nextTicketSeq(d.repo);
    const nextId = `${key}-${String(seq).padStart(4, '0')}`;
    const hasOpenspec = existsSync(join(d.repo, 'openspec'));
    const pmPromptText = pmTicketPrompt({ n: goal.n, title: goal.title }, key, nextId, {
      notes: promptNotes,
      hasOpenspec,
      docsTicket: Boolean(d.cfg.release?.docs_ticket),
    });
    const pmSnapshot = snapshotTurn(d.repo, goal.branch, baseBranch, d.store, 'pm');
    if (pmSnapshot.protectedBranchMoved) {
      d.store.endTurn(pmTurnId, 'rejected', 'protected_branch_moved');
      return {
        status: 'needs_owner',
        sessionId,
        tasks,
        notes: [
          `protected_branch_moved: ${pmSnapshot.protectedHead} → ${pmSnapshot.protectedBranchActualSha ?? ''}`,
          'protected_branch_moved',
        ],
      };
    }
    const recordedBeforePm = recordExistingTickets(d.repo);
    const prePmStatus = new Set(getWorkingTreeChanges(d.repo));

    let pmOutput;
    try {
      pmOutput = await d.runner('pm', ctx.pmAgent, pmPromptText, d.repo, pmLogFile, { signal: d.signal });
    } catch (err) {
      const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
      d.store.endTurn(pmTurnId, 'error', reason);
      const pmGuard = guardStoredAgentTurn(d.store, d.repo, pmSnapshot, 'pm', {
        isErrorOrTimeoutOrAbort: true,
      });
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      if (pmGuard.gitConfigTampered) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
      }
      if (pmGuard.modifiedProtectedBranch) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
      }
      if (pmGuard.protectedBranchMoved) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
      }
      if (pmGuard.modifiedOtherGoal) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
      }
      if (isAbort) {
        return { status: 'stopped', sessionId, tasks, notes: [reason] };
      }
      return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
    }

    if (pmOutput.timedOut || pmOutput.exitCode !== 0 || d.signal?.aborted) {
      const isAbort = Boolean(d.signal?.aborted);
      const reason = isAbort ? 'aborted' : (pmOutput.timedOut ? 'timeout' : `exit_${pmOutput.exitCode}`);
      d.store.endTurn(pmTurnId, isAbort || pmOutput.timedOut ? (isAbort ? 'error' : 'timeout') : 'error', reason);
      const pmGuard = guardStoredAgentTurn(d.store, d.repo, pmSnapshot, 'pm', {
        isErrorOrTimeoutOrAbort: true,
      });
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      if (pmGuard.gitConfigTampered) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
      }
      if (pmGuard.modifiedProtectedBranch) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
      }
      if (pmGuard.protectedBranchMoved) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
      }
      if (pmGuard.modifiedOtherGoal) {
        return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
      }
      if (isAbort) {
        return { status: 'stopped', sessionId, tasks, notes: [reason] };
      }
      return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
    }
    const pmGuard = guardStoredAgentTurn(d.store, d.repo, pmSnapshot, 'pm');
    d.store.endTurn(pmTurnId, 'ok');

    if (pmGuard.gitConfigTampered) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
    }
    if (pmGuard.modifiedProtectedBranch) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
    }
    if (pmGuard.protectedBranchMoved) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
    }
    if (pmGuard.modifiedOtherGoal) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
    }
    if (pmGuard.switchedBranch) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_switched_branch'] };
    }

    if (pmModifiedExistingTickets(d.repo, recordedBeforePm)) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return { status: 'needs_owner', sessionId, tasks, notes: ['pm_modified_existing_ticket'] };
    }

    const postPmStatus = getWorkingTreeChanges(d.repo);
    const pmChanged = postPmStatus.filter((p) => !prePmStatus.has(p));
    const pmOutOfScope = pmChanged.filter((p) => !p.startsWith('team/tickets/'));
    if (pmOutOfScope.length > 0) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return { status: 'needs_owner', sessionId, tasks, notes: ['pm_out_of_scope'] };
    }

    let tickets: Ticket[] = [];
    try {
      tickets = loadTickets(d.repo, key).filter(
        (t) => !recordedBeforePm.files.has(`${t.id}.md`)
      );
      if (tickets.length === 0) {
        throw new TicketError(`No tickets created by PM for goal G${goal.n}`);
      }
      if (tickets.some((t) => t.goal !== `G${goal.n}`)) {
        cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: ['pm_ticket_wrong_goal'],
        };
      }
      const numParts = tickets.map((t) => {
        const parts = t.id.split('-');
        return parts.length === 2 && parts[0] === key ? parseInt(parts[1], 10) : NaN;
      });
      numParts.sort((a, b) => a - b);
      const isSequential = numParts.every((num, idx) => num === seq + idx);
      if (!isSequential) {
        cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: ['pm_ticket_id_not_sequential'],
        };
      }
      if (hasInvalidDependsOn(tickets, tickets, `G${goal.n}`, key)) {
        cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: ['pm_ticket_bad_depends'],
        };
      }
    } catch (err: any) {
      cleanupPmWorkingTree(d.repo, recordedBeforePm, prePmStatus);
      return {
        status: 'needs_owner',
        sessionId,
        tasks,
        notes: [`PM ticket error: ${err?.message || String(err)}`],
      };
    }

    let maxUsed = seq;
    for (const t of tickets) {
      d.store.upsertTicket(d.repo, t);
      d.store.setTicketState(d.repo, t.id, 'pending', ctx.pmAgent, 'PM created ticket', 0);
      tasks[t.id] = 'pending';
      const num = parseInt(t.id.split('-')[1], 10);
      if (num > maxUsed) maxUsed = num;
    }
    d.store.bumpTicketSeq(d.repo, maxUsed);

    const firstId = tickets[0].id;
    const lastId = tickets[tickets.length - 1].id;
    commitAll(d.repo, `${firstId}..${lastId}: PM tickets for G${goal.n}`, ctx.pmAuthor);

    existingGoalTickets = tickets;
  }

  return null;
}

/** Vòng ticket: Dev → gate → QC cho từng ticket theo thứ tự. null = mọi ticket đã xử lý xong vòng này. */
export async function runTickets(ctx: GoalCtx, goalTickets: Ticket[]): Promise<SessionOutcome | null> {
  const { d, sessionId, goal, key, tasks, o, attachedNote, baseBranch, refreshFn, gateFn,
    ownerAnswers, answerImages, askQuestions, backupsFor, pickSeatAgent } = ctx;
  void o; void attachedNote; void refreshFn; void gateFn; void baseBranch;
  for (const ticket of goalTickets) {
    if (d.signal?.aborted) {
      return {
        status: 'stopped',
        sessionId,
        tasks,
        notes: ['Session aborted'],
      };
    }
    const stored = d.store.getTicketState(d.repo, ticket.id);
    const initialTaskState = stored?.state ?? tasks[ticket.id] ?? 'pending';

    if (initialTaskState === 'passed' || initialTaskState === 'cancelled') {
      tasks[ticket.id] = initialTaskState;
      continue;
    }

    // Plan 6 Task 4: ticket còn câu hỏi chưa trả lời → dừng goal chờ anh (không chạy ticket khác để commit các
    // ticket không xen nhau trong base..HEAD).
    {
      const openQ = d.store.listQuestions(d.repo, 'open').filter((q) => q.ticket === ticket.id).length;
      if (openQ > 0) {
        tasks[ticket.id] = stored?.state ?? 'returned';
        return { status: 'needs_owner', sessionId, tasks, notes: [`questions_open:${openQ}`, `Ticket ${ticket.id} waits for your answers`] };
      }
    }

    // Check Definition of Ready
    const readyErrors = checkReady(ticket, (id) => d.store.getTicketState(d.repo, id)?.state ?? null);
    if (readyErrors.length > 0) {
      const reason = `not_ready: ${readyErrors.join(', ')}`;
      d.store.setTicketState(d.repo, ticket.id, 'blocked', 'core', reason);
      tasks[ticket.id] = 'blocked';
      return {
        status: 'needs_owner',
        sessionId,
        tasks,
        notes: [`Ticket ${ticket.id} is blocked: ${reason}`],
      };
    }

    let base = stored?.base_sha || null;
    let fixNotes: string[] = [];
    let fixRounds = stored?.fix_rounds ?? 0;

    if (initialTaskState === 'returned') {
      const reportsDir = join(d.repo, 'team', 'reports');
      const qcReportPath = join(reportsDir, `${ticket.id}-qc.json`);
      if (existsSync(qcReportPath)) {
        try {
          const qcData = JSON.parse(readFileSync(qcReportPath, 'utf8'));
          if (Array.isArray(qcData.bugs) || Array.isArray(qcData.fix)) {
            fixNotes = [...(qcData.bugs || []), ...(qcData.fix || [])];
          }
        } catch {}
      }
      if (fixNotes.length === 0) {
        const failures = d.store.listHandoffFailures(sessionId).filter((f) => f.task_id === ticket.id);
        if (failures.length > 0) {
          fixNotes = failures.map((f) => f.reason);
        }
      }
    }

    // Plan 6 Task 3+4: ghi chú dòng và câu trả lời của anh đi trước ghi chú QC.
    const ownerNotes = [
      ...d.store.listLineNotes(d.repo, ticket.id, true).map((n) => `Anh Zon (${n.path}:${n.line}): ${n.text}`),
      ...ownerAnswers(ticket.id),
    ];
    if (ownerNotes.length > 0) fixNotes = [...ownerNotes, ...fixNotes];

    let skipDevThisRound = (initialTaskState === 'awaiting_qc');
    const coders = new Set<string>();
    for (const t of d.store.listTurns(sessionId)) {
      if (t.seat === 'dev' && t.task_id === ticket.id && t.agent) {
        coders.add(t.agent);
      }
    }
    try {
      const hist = d.store.ticketHistory(d.repo, ticket.id);
      for (const h of hist) {
        if ((h.to_state === 'in_dev' || h.to_state === 'awaiting_qc') && h.by) {
          coders.add(h.by);
        }
      }
    } catch {}

    let ticketImages: string[] | undefined;
    if (ticket.note) {
      const rawId = ticket.note.replace(/^N-/, '');
      const noteIdNum = Number(rawId);
      if (!isNaN(noteIdNum)) {
        const note = d.store.getNote(noteIdNum);
        if (note?.image) {
          try {
            const imgPath = inboxPath(d.repo, note.image);
            if (existsSync(imgPath)) {
              ticketImages = [imgPath];
            }
          } catch {}
        }
      }
    }

    const qImages = answerImages(ticket.id);
    if (qImages.length > 0) ticketImages = [...(ticketImages ?? []), ...qImages];

    while (true) {
      if (d.signal?.aborted) {
        return {
          status: 'stopped',
          sessionId,
          tasks,
          notes: ['Session aborted'],
        };
      }
      const seats = effectiveSeats(d.cfg, d.store, d.repo);
      let devAgent = Object.hasOwn(seats, 'dev') ? seats.dev : d.cfg.seats.dev;
      let devAuthor = authorForAgent(devAgent);

      const pastDevTurns = d.store
        .listTurns(sessionId)
        .filter((t) => t.seat === 'dev' && t.task_id === ticket.id);
      const prevCoder = pastDevTurns.length > 0 ? pastDevTurns[pastDevTurns.length - 1].agent : null;

      const currentTicketState = d.store.getTicketState(d.repo, ticket.id)?.state ?? tasks[ticket.id];
      // Tính sau khi chọn người ngồi (có thể là người dự phòng).
      const isHandoffFor = (agent: string) =>
        (currentTicketState === 'returned' || currentTicketState === 'in_dev') &&
        prevCoder !== null &&
        prevCoder !== agent;

      if (!skipDevThisRound) {
        if (!base) {
          base = headSha(d.repo);
        }
        {
          const pick = await pickSeatAgent('dev', devAgent);
          if (pick.agent === null) {
            d.store.recordHandoffFailure(sessionId, ticket.id, pick.notes[0] ?? 'gate');
            return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
          }
          devAgent = pick.agent;
          devAuthor = authorForAgent(devAgent);
        }
        coders.add(devAgent);

        if (isOutOfTurns(d.store, sessionId, d.cfg, 'dev')) {
          return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns'] };
        }

        d.store.setTicketState(d.repo, ticket.id, 'in_dev', devAgent, 'dev started', fixRounds, base);
        tasks[ticket.id] = 'in_dev';

        const devTurnId = d.store.startTurn(sessionId, 'dev', devAgent, ticket.id);
        const devLogFile = join(d.logDir, `turn-${devTurnId}.log`);
        d.store.setTurnLog(devTurnId, devLogFile);

        const devPromptText = devTicketPrompt(
          ticket,
          devAgent,
          fixNotes,
          d.cfg.runner.agy_allow_commands,
          isHandoffFor(devAgent)
        );

        const devSnapshot = snapshotTurn(d.repo, goal.branch, baseBranch, d.store, 'dev');
        if (devSnapshot.protectedBranchMoved) {
          d.store.endTurn(devTurnId, 'rejected', 'protected_branch_moved');
          return {
            status: 'needs_owner',
            sessionId,
            tasks,
            notes: [
              `protected_branch_moved: ${devSnapshot.protectedHead} → ${devSnapshot.protectedBranchActualSha ?? ''}`,
              'protected_branch_moved',
            ],
          };
        }
        let devOutput;
        try {
          devOutput = await d.runner('dev', devAgent, devPromptText, d.repo, devLogFile, {
            signal: d.signal,
            images: ticketImages,
          });
        } catch (err) {
          const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
          const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
          d.store.endTurn(devTurnId, 'error', reason);
          const devGuard = guardStoredAgentTurn(d.store, d.repo, devSnapshot, 'dev', {
            isErrorOrTimeoutOrAbort: true,
            taskId: ticket.id,
            author: devAuthor,
            reason,
          });
          if (devGuard.gitConfigTampered) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
          }
          if (devGuard.modifiedProtectedBranch) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
          }
          if (devGuard.protectedBranchMoved) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
          }
          if (devGuard.modifiedOtherGoal) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
          }
          if (isAbort) {
            return { status: 'stopped', sessionId, tasks, notes: [reason] };
          }
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        if (d.signal?.aborted) {
          const reason = 'aborted';
          d.store.endTurn(devTurnId, 'error', reason);
          const devGuard = guardStoredAgentTurn(d.store, d.repo, devSnapshot, 'dev', {
            isErrorOrTimeoutOrAbort: true,
            taskId: ticket.id,
            author: devAuthor,
            reason,
          });
          if (devGuard.gitConfigTampered) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
          }
          if (devGuard.modifiedProtectedBranch) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
          }
          if (devGuard.protectedBranchMoved) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
          }
          if (devGuard.modifiedOtherGoal) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
          }
          return { status: 'stopped', sessionId, tasks, notes: [reason] };
        }

        if (devOutput.timedOut) {
          const reason = 'timeout';
          d.store.endTurn(devTurnId, 'timeout', reason);
          const devGuard = guardStoredAgentTurn(d.store, d.repo, devSnapshot, 'dev', {
            isErrorOrTimeoutOrAbort: true,
            taskId: ticket.id,
            author: devAuthor,
            reason,
          });
          if (devGuard.gitConfigTampered) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
          }
          if (devGuard.modifiedProtectedBranch) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
          }
          if (devGuard.protectedBranchMoved) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
          }
          if (devGuard.modifiedOtherGoal) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
          }
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        const hasAutoDenied =
          (devOutput.output || '').includes('auto-denied') ||
          (devOutput.lastMessage || '').includes('auto-denied');

        if (!hasAutoDenied && devOutput.exitCode !== 0) {
          const reason = `exit_${devOutput.exitCode}`;
          d.store.endTurn(devTurnId, 'error', reason);
          const devGuard = guardStoredAgentTurn(d.store, d.repo, devSnapshot, 'dev', {
            isErrorOrTimeoutOrAbort: true,
            taskId: ticket.id,
            author: devAuthor,
            reason,
          });
          if (devGuard.gitConfigTampered) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
          }
          if (devGuard.modifiedProtectedBranch) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
          }
          if (devGuard.protectedBranchMoved) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
          }
          if (devGuard.modifiedOtherGoal) {
            return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
          }
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        const devGuard = guardStoredAgentTurn(d.store, d.repo, devSnapshot, 'dev');
        if (devGuard.gitConfigTampered) {
          d.store.endTurn(devTurnId, 'rejected', 'git_config_tampered');
          return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
        }
        if (devGuard.modifiedProtectedBranch) {
          d.store.endTurn(devTurnId, 'rejected', 'agent_modified_protected_branch');
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
        }
        if (devGuard.protectedBranchMoved) {
          d.store.endTurn(devTurnId, 'rejected', 'protected_branch_moved');
          return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
        }
        if (devGuard.modifiedOtherGoal) {
          d.store.endTurn(devTurnId, 'rejected', 'agent_modified_other_goal');
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
        }
        if (devGuard.switchedBranch) {
          d.store.endTurn(devTurnId, 'rejected', 'agent_switched_branch');
          d.store.recordHandoffFailure(sessionId, ticket.id, 'agent_switched_branch');
          fixNotes = ['agent_switched_branch'];
          fixRounds++;
          if (fixRounds > d.cfg.turn.max_fix_rounds) {
            tasks[ticket.id] = 'failed';
            d.store.setTicketState(d.repo, ticket.id, 'failed', devAgent, 'max fix rounds exceeded', fixRounds, base);
            for (const rem of goalTickets) {
              if (!tasks[rem.id] || tasks[rem.id] === 'pending') {
                const remReady = checkReady(rem, (id) => d.store.getTicketState(d.repo, id)?.state ?? null);
                if (remReady.length > 0) {
                  const reason = `not_ready: ${remReady.join(', ')}`;
                  d.store.setTicketState(d.repo, rem.id, 'blocked', 'core', reason);
                  tasks[rem.id] = 'blocked';
                }
              }
            }
            return {
              status: 'needs_owner',
              sessionId,
              tasks,
              notes: [
                `Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: agent_switched_branch`,
              ],
            };
          }
          d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, 'agent_switched_branch', fixRounds, base);
          tasks[ticket.id] = 'returned';
          continue;
        }

        // BLOCKED chỉ khi câu trả lời cuối của Dev MỞ ĐẦU một dòng bằng BLOCKED. Không quét cả output: codex in lại
        // prompt (luôn có "Bị nghẽn trả lời BLOCKED") nên lượt làm xong vẫn bị coi là BLOCKED (GT-0005, 2026-11-14).
        if (/(^|\n)\s*(\*\*)?BLOCKED\b/.test(devOutput.lastMessage || '')) {
          d.store.endTurn(devTurnId, 'ok');
          try {
            restoreTicketFilesFromBase(d.repo, base);
            commitAll(d.repo, `${ticket.id}: blocked`, devAuthor);
          } catch {}
          // Dev vừa báo BLOCKED vừa hỏi "Cần xác nhận …?" → coi như câu hỏi (ticket returned, chờ anh trả lời),
          // không kẹt blocked mà anh không có chỗ trả lời.
          const blockedQ = askQuestions(ticket.id, 'dev', devAgent, parseReportQuestions(readReport(join(d.repo, 'team', 'reports', `${ticket.id}-dev.md`))));
          if (blockedQ > 0) {
            d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, 'questions_open', fixRounds, base);
            tasks[ticket.id] = 'returned';
            return { status: 'needs_owner', sessionId, tasks, notes: [`questions_open:${blockedQ}`, `Ticket ${ticket.id} waits for your answers`] };
          }
          tasks[ticket.id] = 'blocked';
          d.store.setTicketState(d.repo, ticket.id, 'blocked', devAgent, 'Dev reported BLOCKED', fixRounds, base);
          return { status: 'needs_owner', sessionId, tasks, notes: ['Dev reported BLOCKED'] };
        }

        const devCleanedCount = devGuard.ignoredCleanedCount ?? 0;
        d.store.endTurn(
          devTurnId,
          'ok',
          devGuard.ignoredListFailed
            ? 'ignored_list_failed'
            : (devCleanedCount > 0 ? `ignored_cleaned:${devCleanedCount}` : undefined)
        );
        try {
          commitAll(d.repo, `${ticket.id}: dev implementation`, devAuthor);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { status: 'needs_owner', sessionId, tasks, notes: [`commitAll error: ${reason}`] };
        }
        d.store.markLineNotesUsed(d.repo, ticket.id);
        d.store.markQuestionsUsed(d.repo, ticket.id);
        // Plan 6 Task 4: Dev hỏi → giữ code đã commit, base giữ nguyên (QC sau vẫn xem toàn bộ base..HEAD), ticket
        // về returned và goal dừng chờ anh trả lời; lần sau Dev làm tiếp với câu trả lời.
        const newQ = askQuestions(ticket.id, 'dev', devAgent, parseReportQuestions(readReport(join(d.repo, 'team', 'reports', `${ticket.id}-dev.md`))));
        if (newQ > 0) {
          d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, 'questions_open', fixRounds, base);
          tasks[ticket.id] = 'returned';
          return { status: 'needs_owner', sessionId, tasks, notes: [`questions_open:${newQ}`, `Ticket ${ticket.id} waits for your answers`] };
        }

        const timeoutMs = (d.cfg.turn.timeout_minutes.dev ?? 0) * 60 * 1000;
        const gateSnapshot = snapshotTurn(d.repo, goal.branch, baseBranch, d.store, 'qc');
        if (gateSnapshot.protectedBranchMoved) {
          d.store.endTurn(devTurnId, 'rejected', 'protected_branch_moved');
          return {
            status: 'needs_owner',
            sessionId,
            tasks,
            notes: [
              `protected_branch_moved: ${gateSnapshot.protectedHead} → ${gateSnapshot.protectedBranchActualSha ?? ''}`,
              'protected_branch_moved',
            ],
          };
        }
        const gateResult = runGate(d.repo, ticket, base, d.cfg.gate.commands, {
          cfg: d.cfg,
          // Plan 7: gate chạy dưới đúng tài khoản Dev vừa code (không đụng tài khoản default có thể đang ngủ).
          agentId: d.store.getSetting(accountLastKey(devAgent)) || devAgent,
          timeoutMs,
          require_report_schema: d.cfg.gate.require_report_schema,
        });
        const gateGuard = guardStoredAgentTurn(d.store, d.repo, gateSnapshot, 'qc');
        const totalCleanedAfterGate = devCleanedCount + (gateGuard.ignoredCleanedCount ?? 0);
        if (gateGuard.ignoredListFailed) {
          d.store.endTurn(devTurnId, 'ok', 'ignored_list_failed');
        } else if (totalCleanedAfterGate > devCleanedCount) {
          d.store.endTurn(devTurnId, 'ok', `ignored_cleaned:${totalCleanedAfterGate}`);
        }
        if (gateGuard.gitConfigTampered) {
          d.store.endTurn(devTurnId, 'rejected', 'git_config_tampered');
          d.store.recordHandoffFailure(sessionId, ticket.id, 'git_config_tampered');
          return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
        }
        if (gateGuard.protectedBranchMoved || gateGuard.modifiedProtectedBranch) {
          d.store.endTurn(devTurnId, 'rejected', 'protected_branch_moved');
          d.store.recordHandoffFailure(sessionId, ticket.id, 'protected_branch_moved');
          return {
            status: 'needs_owner',
            sessionId,
            tasks,
            notes: ['protected_branch_moved', 'agent_modified_protected_branch'],
          };
        }
        if (gateGuard.modifiedOtherGoal) {
          d.store.endTurn(devTurnId, 'rejected', 'agent_modified_other_goal');
          d.store.recordHandoffFailure(sessionId, ticket.id, 'agent_modified_other_goal');
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
        }
        if (gateGuard.switchedBranch) {
          d.store.endTurn(devTurnId, 'rejected', 'agent_switched_branch');
          d.store.recordHandoffFailure(sessionId, ticket.id, 'agent_switched_branch');
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_switched_branch'] };
        }
        if (gateGuard.headChanged) {
          d.store.endTurn(devTurnId, 'rejected', 'qc_modified_repo');
          d.store.recordHandoffFailure(sessionId, ticket.id, 'qc_modified_repo');
          return { status: 'needs_owner', sessionId, tasks, notes: ['qc_modified_repo'] };
        }
        if (!gateResult.ok || hasAutoDenied) {
          const failureReasons: string[] = [];
          if (hasAutoDenied) failureReasons.push('command_denied');
          if (!gateResult.ok) failureReasons.push(...gateResult.reasons);

          if (failureReasons.includes('ticket_tampered')) {
            try {
              const headFiles = git(d.repo, 'ls-tree', '-r', '--name-only', 'HEAD', 'team/tickets')
                .split(/\r?\n/)
                .filter(Boolean);
              const baseFiles = new Set(
                git(d.repo, 'ls-tree', '-r', '--name-only', base, 'team/tickets')
                  .split(/\r?\n/)
                  .filter(Boolean)
              );
              for (const f of headFiles) {
                if (!baseFiles.has(f)) {
                  try { rmSync(join(d.repo, f), { force: true }); } catch {}
                }
              }
              git(d.repo, 'checkout', base, '--', 'team/tickets');
              commitAll(d.repo, `${ticket.id}: restore tickets`, { name: 'core', email: 'core@btm.local' });
              const reloaded = loadTickets(d.repo, key, `G${goal.n}`);
              const found = reloaded.find((t) => t.id === ticket.id);
              if (found) {
                Object.assign(ticket, found);
              }
            } catch {}
          }

          const dirtyAfterGateFail = git(d.repo, 'status', '--porcelain').trim();
          if (dirtyAfterGateFail) {
            try {
              git(d.repo, 'checkout', '--', '.');
              git(d.repo, 'clean', '-fd');
            } catch {}
          }

          d.store.endTurn(devTurnId, 'rejected', failureReasons.join('; '));
          for (const reason of failureReasons) {
            d.store.recordHandoffFailure(sessionId, ticket.id, reason);
          }

          const deniedNote = 'command_denied: use only allowed commands, one per call';
          fixNotes = [
            ...(hasAutoDenied ? [deniedNote] : []),
            ...(!gateResult.ok ? gateResult.reasons : []),
          ];
          fixRounds++;
          if (fixRounds > d.cfg.turn.max_fix_rounds) {
            tasks[ticket.id] = 'failed';
            d.store.setTicketState(d.repo, ticket.id, 'failed', devAgent, 'max fix rounds exceeded', fixRounds, base);
            for (const rem of goalTickets) {
              if (!tasks[rem.id] || tasks[rem.id] === 'pending') {
                const remReady = checkReady(rem, (id) => d.store.getTicketState(d.repo, id)?.state ?? null);
                if (remReady.length > 0) {
                  const reason = `not_ready: ${remReady.join(', ')}`;
                  d.store.setTicketState(d.repo, rem.id, 'blocked', 'core', reason);
                  tasks[rem.id] = 'blocked';
                }
              }
            }
            return {
              status: 'needs_owner',
              sessionId,
              tasks,
              notes: [
                `Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: ${failureReasons.join(', ')}`,
              ],
            };
          }
          d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, failureReasons.join('; '), fixRounds, base);
          tasks[ticket.id] = 'returned';
          continue;
        }

        // 5. #10 Lệnh gate làm bẩn tree.
        // Sau khi chạy build/lint/test của gate, tree bẩn bởi file không bị ignore
        // → git clean -fd + git checkout -- . các file đó rồi mới gọi QC (ghi log 1 dòng),
        // để QC không bị qc_modified_repo oan.
        const dirtyAfterGate = git(d.repo, 'status', '--porcelain').trim();
        if (dirtyAfterGate) {
          try {
            git(d.repo, 'checkout', '--', '.');
            git(d.repo, 'clean', '-fd');
            console.log(`[gate] cleaned dirty tree after gate commands: ${dirtyAfterGate.replace(/\r?\n/g, ', ')}`);
          } catch {}
        }
      } else {
        skipDevThisRound = false;
        if (!base) {
          base = stored?.base_sha || headSha(d.repo);
        }
      }

      d.store.setTicketState(d.repo, ticket.id, 'awaiting_qc', devAgent, 'ready for qc', fixRounds, base);
      tasks[ticket.id] = 'awaiting_qc';

      // Rule 8: coder_cannot_qc_same_task
      let qcAgent = Object.hasOwn(seats, 'qc') ? seats.qc : d.cfg.seats.qc;
      try {
        const hist = d.store.ticketHistory(d.repo, ticket.id);
        for (const h of hist) {
          if ((h.to_state === 'in_dev' || h.to_state === 'awaiting_qc') && h.by) {
            coders.add(h.by);
          }
        }
      } catch {}
      const qcRule = d.cfg.rules.coder_cannot_qc_same_task;
      const qcHasSub = backupsFor('qc').some((a) => !coders.has(a));
      if (qcRule && coders.has(qcAgent) && !qcHasSub) {
        d.store.recordHandoffFailure(sessionId, ticket.id, 'coder_cannot_qc_same_task');
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: [
            `Seat 'qc' is occupied by '${qcAgent}', who also coded task '${ticket.id}'`,
            'coder_cannot_qc_same_task',
          ],
        };
      }

      {
        const pick = await pickSeatAgent('qc', qcAgent, qcRule ? coders : new Set());
        if (pick.agent === null) {
          d.store.recordHandoffFailure(sessionId, ticket.id, pick.notes[0] ?? 'gate');
          return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
        }
        qcAgent = pick.agent;
      }

      if (isOutOfTurns(d.store, sessionId, d.cfg, 'qc')) {
        return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns'] };
      }

      const qcAuthor = authorForAgent(qcAgent);
      const qcTurnId = d.store.startTurn(sessionId, 'qc', qcAgent, ticket.id);
      const qcLogFile = join(d.logDir, `turn-${qcTurnId}.log`);
      d.store.setTurnLog(qcTurnId, qcLogFile);
      const qcPromptText = qcTicketPrompt(ticket, base, qcAgent, ownerAnswers(ticket.id));
      const qcSnapshot = snapshotTurn(d.repo, goal.branch, baseBranch, d.store, 'qc');
      if (qcSnapshot.protectedBranchMoved) {
        d.store.endTurn(qcTurnId, 'rejected', 'protected_branch_moved');
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: [
            `protected_branch_moved: ${qcSnapshot.protectedHead} → ${qcSnapshot.protectedBranchActualSha ?? ''}`,
            'protected_branch_moved',
          ],
        };
      }

      let qcOutput;
      try {
        qcOutput = await d.runner('qc', qcAgent, qcPromptText, d.repo, qcLogFile, {
          signal: d.signal,
          images: ticketImages,
        });
      } catch (err) {
        const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
        const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
        d.store.endTurn(qcTurnId, 'error', reason);
        const qcGuard = guardStoredAgentTurn(d.store, d.repo, qcSnapshot, 'qc', { isErrorOrTimeoutOrAbort: true });
        if (qcGuard.gitConfigTampered) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
        }
        if (qcGuard.modifiedProtectedBranch) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
        }
        if (qcGuard.protectedBranchMoved) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
        }
        if (qcGuard.modifiedOtherGoal) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
        }
        if (isAbort) {
          return { status: 'stopped', sessionId, tasks, notes: [reason] };
        }
        return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
      }

      if (qcOutput.timedOut || qcOutput.exitCode !== 0) {
        const reason = qcOutput.timedOut ? 'timeout' : `exit_${qcOutput.exitCode}`;
        d.store.endTurn(qcTurnId, qcOutput.timedOut ? 'timeout' : 'error', reason);
        const qcGuard = guardStoredAgentTurn(d.store, d.repo, qcSnapshot, 'qc', { isErrorOrTimeoutOrAbort: true });
        if (qcGuard.gitConfigTampered) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
        }
        if (qcGuard.modifiedProtectedBranch) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
        }
        if (qcGuard.protectedBranchMoved) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
        }
        if (qcGuard.modifiedOtherGoal) {
          return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
        }
        return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
      }

      d.store.endTurn(qcTurnId, 'ok');

      let qcResult = parseTicketQcResult(qcOutput.lastMessage, {
        ticket: ticket.id,
        goal: ticket.goal,
        number: ticket.number,
      });

      const qcGuard = guardStoredAgentTurn(d.store, d.repo, qcSnapshot, 'qc');
      if (qcGuard.ignoredListFailed) {
        d.store.endTurn(qcTurnId, 'ok', 'ignored_list_failed');
      } else if ((qcGuard.ignoredCleanedCount ?? 0) > 0) {
        d.store.endTurn(qcTurnId, 'ok', `ignored_cleaned:${qcGuard.ignoredCleanedCount}`);
      }
      if (qcGuard.gitConfigTampered) {
        d.store.endTurn(qcTurnId, 'rejected', 'git_config_tampered');
        return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
      }
      if (qcGuard.protectedBranchMoved && !qcGuard.modifiedProtectedBranch) {
        d.store.endTurn(qcTurnId, 'rejected', 'protected_branch_moved');
        return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
      }
      if (
        qcGuard.switchedBranch ||
        qcGuard.headChanged ||
        qcGuard.treeDirty ||
        qcGuard.modifiedProtectedBranch ||
        qcGuard.modifiedOtherGoal
      ) {
        const reasons: string[] = [];
        if (qcGuard.modifiedProtectedBranch) reasons.push('agent_modified_protected_branch');
        if (qcGuard.modifiedOtherGoal) reasons.push('agent_modified_other_goal');
        if (qcGuard.switchedBranch) reasons.push('agent_switched_branch');
        if (qcGuard.headChanged || qcGuard.treeDirty) reasons.push('qc_modified_repo');
        qcResult = {
          verdict: 'fail',
          bugs: reasons,
          fix: reasons,
          confirm: [],
        };
      }

      const reportsDir = join(d.repo, 'team', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const qcReportPath = join(reportsDir, `${ticket.id}-qc.json`);
      const qcDataToSave = {
        ticket: ticket.id,
        goal: ticket.goal,
        number: ticket.number,
        ...qcResult,
      };
      writeFileSync(qcReportPath, JSON.stringify(qcDataToSave, null, 2) + '\n', 'utf8');
      try {
        commitAll(d.repo, `${ticket.id}: qc ${qcResult.verdict}`, qcAuthor);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { status: 'needs_owner', sessionId, tasks, notes: [`commitAll error: ${reason}`] };
      }

      if (qcResult.verdict === 'pass') {
        tasks[ticket.id] = 'passed';
        d.store.setTicketState(d.repo, ticket.id, 'passed', qcAgent, 'qc passed', fixRounds, base);
        break;
      }

      // QC fail mà không có lỗi/việc cần sửa, chỉ có mục "cần xác nhận" (vd sandbox không mở được cổng):
      // không trả về Dev (Dev không có gì để sửa → lặp tốn lượt). Hỏi anh; anh trả lời rồi Resume thì QC chạy lại.
      if (qcResult.bugs.length === 0 && qcResult.fix.length === 0) {
        const confirmItems = cleanConfirmItems(qcResult.confirm);
        if (confirmItems.length > 0) {
          const newQ = askQuestions(ticket.id, 'qc', qcAgent, confirmItems);
          d.store.setTicketState(d.repo, ticket.id, 'awaiting_qc', 'core', 'qc_needs_confirm', fixRounds, base);
          tasks[ticket.id] = 'awaiting_qc';
          return newQ > 0
            ? { status: 'needs_owner', sessionId, tasks, notes: [`questions_open:${newQ}`, `QC for ${ticket.id} needs your confirmation`] }
            : { status: 'needs_owner', sessionId, tasks, notes: ['qc_confirm_unresolved', `QC still cannot confirm ${ticket.id} after your answers`] };
        }
      }

      fixRounds++;
      fixNotes = [...qcResult.bugs, ...qcResult.fix];
      if (fixRounds > d.cfg.turn.max_fix_rounds) {
        tasks[ticket.id] = 'failed';
        d.store.setTicketState(d.repo, ticket.id, 'failed', qcAgent, 'max fix rounds exceeded', fixRounds, base);
        for (const rem of goalTickets) {
          if (!tasks[rem.id] || tasks[rem.id] === 'pending') {
            const remReady = checkReady(rem, (id) => d.store.getTicketState(d.repo, id)?.state ?? null);
            if (remReady.length > 0) {
              const reason = `not_ready: ${remReady.join(', ')}`;
              d.store.setTicketState(d.repo, rem.id, 'blocked', 'core', reason);
              tasks[rem.id] = 'blocked';
            }
          }
        }
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: [`Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: ${fixNotes.join(', ')}`],
        };
      }
      d.store.setTicketState(d.repo, ticket.id, 'returned', qcAgent, fixNotes.join('; '), fixRounds, base);
      tasks[ticket.id] = 'returned';
    }
  }

  return null;
}

/** Kiểm ticket + Audit; audit fail → PM lập ticket sửa. 'again' = chạy lại vòng ticket; 'break' = sang kiểm tra cuối. */
export async function runAuditPhase(ctx: GoalCtx): Promise<SessionOutcome | 'again' | 'break'> {
  const { d, sessionId, goal, key, tasks, o, attachedNote, baseBranch, refreshFn, gateFn,
    ownerAnswers, answerImages, askQuestions, backupsFor, pickSeatAgent } = ctx;
  void o; void attachedNote; void refreshFn; void gateFn; void baseBranch;
  // 5. Goal tickets verification & Audit
  const goalTicketsAfter = loadTickets(d.repo, key, `G${goal.n}`);
  const allPassed =
    goalTicketsAfter.length > 0 &&
    goalTicketsAfter.every((t) => {
      const s = d.store.getTicketState(d.repo, t.id);
      return s?.state === 'passed';
    });

  if (!allPassed) {
    return 'break'; // thoát vòng while của processGoal → kiểm tra cuối
  }

  let auditAgent = effectiveSeats(d.cfg, d.store, d.repo).audit || d.cfg.seats.audit;
  if (!auditAgent && d.cfg.release?.require_audit) {
    // Decision 0006: không được bỏ qua audit khi đã bật require_audit.
    d.store.setGoalState(d.repo, goal.n, 'qc_done', 'core', 'all tickets passed; audit seat missing');
    return { status: 'needs_owner', sessionId, tasks, notes: ['audit_seat_missing'] };
  }
  if (!auditAgent) {
    writeGoalSummaryAndCommit(d.repo, goal, goalTicketsAfter, d.store);
    const reviewedSha = git(d.repo, 'rev-parse', `refs/heads/${goal.branch}`).trim();
    d.store.setGoalState(d.repo, goal.n, 'qc_done', 'core', 'all tickets passed', reviewedSha);
    return 'break'; // thoát vòng while của processGoal → kiểm tra cuối
  } else {
    d.store.setGoalState(d.repo, goal.n, 'qc_done', 'core', 'all tickets passed');
  }

  // Agent audit != mọi agent đã code ticket nào của goal
  const goalTicketIds = new Set(goalTicketsAfter.map((t) => t.id));
  const goalCoders = new Set<string>();
  for (const t of d.store.listTurns(sessionId)) {
    if (t.seat === 'dev' && t.task_id && goalTicketIds.has(t.task_id) && t.agent) {
      goalCoders.add(t.agent);
    }
  }
  for (const tid of goalTicketIds) {
    try {
      const hist = d.store.ticketHistory(d.repo, tid);
      for (const h of hist) {
        if ((h.to_state === 'in_dev' || h.to_state === 'awaiting_qc') && h.by) {
          goalCoders.add(h.by);
        }
      }
    } catch {}
  }
  const auditHasSub = backupsFor('audit').some((a) => !goalCoders.has(a));
  if (goalCoders.has(auditAgent) && !auditHasSub) {
    d.store.recordHandoffFailure(sessionId, `G${goal.n}`, 'auditor_is_coder');
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [
        `Seat 'audit' is occupied by '${auditAgent}', who coded tickets in goal 'G${goal.n}'`,
        'auditor_is_coder',
      ],
    };
  }

  {
    const pick = await pickSeatAgent('audit', auditAgent, goalCoders);
    if (pick.agent === null) {
      d.store.recordHandoffFailure(sessionId, `G${goal.n}`, pick.notes[0] ?? 'gate');
      return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
    }
    auditAgent = pick.agent;
  }

  if (isOutOfTurns(d.store, sessionId, d.cfg, 'audit')) {
    return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns for Audit'] };
  }

  const auditTurnId = d.store.startTurn(sessionId, 'audit', auditAgent, `G${goal.n}`);
  const auditLogFile = join(d.logDir, `turn-${auditTurnId}.log`);
  d.store.setTurnLog(auditTurnId, auditLogFile);

  let auditBase = baseBranch;
  try {
    const mb = git(d.repo, 'merge-base', baseBranch, 'HEAD').trim();
    if (mb) auditBase = mb;
  } catch {
    auditBase = baseBranch;
  }

  const auditPromptText = auditPrompt(
    { n: goal.n, title: goal.title },
    auditBase,
    goalTicketsAfter.map((t) => t.id),
    auditAgent
  );
  const auditSnapshot = snapshotTurn(d.repo, goal.branch, baseBranch, d.store, 'audit');
  if (auditSnapshot.protectedBranchMoved) {
    d.store.endTurn(auditTurnId, 'rejected', 'protected_branch_moved');
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [
        `protected_branch_moved: ${auditSnapshot.protectedHead} → ${auditSnapshot.protectedBranchActualSha ?? ''}`,
        'protected_branch_moved',
      ],
    };
  }

  let auditOutput;
  try {
    auditOutput = await d.runner('audit', auditAgent, auditPromptText, d.repo, auditLogFile, {
      signal: d.signal,
    });
  } catch (err) {
    const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
    const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
    d.store.endTurn(auditTurnId, 'error', reason);
    const auditGuard = guardStoredAgentTurn(d.store, d.repo, auditSnapshot, 'audit', { isErrorOrTimeoutOrAbort: true });
    if (auditGuard.gitConfigTampered) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
    }
    if (auditGuard.modifiedProtectedBranch) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
    }
    if (auditGuard.protectedBranchMoved) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
    }
    if (auditGuard.modifiedOtherGoal) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
    }
    if (isAbort) {
      return { status: 'stopped', sessionId, tasks, notes: [reason] };
    }
    return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
  }

  if (d.signal?.aborted) {
    const reason = 'aborted';
    d.store.endTurn(auditTurnId, 'error', reason);
    const auditGuard = guardStoredAgentTurn(d.store, d.repo, auditSnapshot, 'audit', { isErrorOrTimeoutOrAbort: true });
    if (auditGuard.gitConfigTampered) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
    }
    if (auditGuard.modifiedProtectedBranch) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
    }
    if (auditGuard.protectedBranchMoved) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
    }
    if (auditGuard.modifiedOtherGoal) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
    }
    return { status: 'stopped', sessionId, tasks, notes: [reason] };
  }

  if (auditOutput.timedOut || auditOutput.exitCode !== 0) {
    const reason = auditOutput.timedOut ? 'timeout' : `exit_${auditOutput.exitCode}`;
    d.store.endTurn(auditTurnId, auditOutput.timedOut ? 'timeout' : 'error', reason);
    const auditGuard = guardStoredAgentTurn(d.store, d.repo, auditSnapshot, 'audit', { isErrorOrTimeoutOrAbort: true });
    if (auditGuard.gitConfigTampered) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
    }
    if (auditGuard.modifiedProtectedBranch) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
    }
    if (auditGuard.protectedBranchMoved) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
    }
    if (auditGuard.modifiedOtherGoal) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
    }
    return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
  }
  d.store.endTurn(auditTurnId, 'ok');

  let auditResult = parseAuditResult(auditOutput.lastMessage || auditOutput.output || '');

  const auditGuard = guardStoredAgentTurn(d.store, d.repo, auditSnapshot, 'audit');
  if (auditGuard.ignoredListFailed) {
    d.store.endTurn(auditTurnId, 'ok', 'ignored_list_failed');
  } else if ((auditGuard.ignoredCleanedCount ?? 0) > 0) {
    d.store.endTurn(auditTurnId, 'ok', `ignored_cleaned:${auditGuard.ignoredCleanedCount}`);
  }
  if (auditGuard.gitConfigTampered) {
    d.store.endTurn(auditTurnId, 'rejected', 'git_config_tampered');
    return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
  }
  if (auditGuard.protectedBranchMoved && !auditGuard.modifiedProtectedBranch) {
    d.store.endTurn(auditTurnId, 'rejected', 'protected_branch_moved');
    return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
  }
  if (
    auditGuard.switchedBranch ||
    auditGuard.headChanged ||
    auditGuard.treeDirty ||
    auditGuard.modifiedProtectedBranch ||
    auditGuard.modifiedOtherGoal
  ) {
    const text = auditGuard.modifiedProtectedBranch
      ? 'agent_modified_protected_branch'
      : (auditGuard.modifiedOtherGoal
        ? 'agent_modified_other_goal'
        : (auditGuard.switchedBranch ? 'agent_switched_branch' : 'audit_modified_repo'));
    auditResult = {
      verdict: 'fail',
      findings: [
        { ticket: '', severity: 'high', text },
      ],
    };
  }

  const reportsDir = join(d.repo, 'team', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const auditReportPath = join(reportsDir, `G${goal.n}-audit.md`);
  const auditReportLines = [
    `G${goal.n} · ${goal.title} · ${auditAgent}-Audit`,
    `Verdict: ${auditResult.verdict}`,
    '',
    '## Findings',
  ];
  if (auditResult.findings.length === 0) {
    auditReportLines.push('OK');
  } else {
    for (const f of auditResult.findings) {
      auditReportLines.push(`- [${f.severity.toUpperCase()}] ${f.ticket ? `${f.ticket}: ` : ''}${f.text}`);
    }
  }
  writeFileSync(auditReportPath, auditReportLines.join('\n') + '\n', 'utf8');
  const coreAuthor = { name: 'core', email: 'core@btm.local' };
  commitAll(d.repo, `G${goal.n}: audit ${auditResult.verdict}`, coreAuthor);

  if (auditResult.verdict === 'pass') {
    writeGoalSummaryAndCommit(d.repo, goal, loadTickets(d.repo, key, `G${goal.n}`), d.store);
    const reviewedSha = git(d.repo, 'rev-parse', `refs/heads/${goal.branch}`).trim();
    d.store.setGoalState(d.repo, goal.n, 'audit_passed', auditAgent, 'audit passed', reviewedSha);
    return 'break'; // thoát vòng while của processGoal → kiểm tra cuối
  }

  if (auditResult.verdict === 'fail' && auditResult.findings.length === 0) {
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: ['audit_fail_no_findings'],
    };
  }

  const sysFindings = auditResult.findings.filter(
    (f) =>
      f.text === 'audit_output_invalid' ||
      f.text === 'audit_modified_repo' ||
      f.text === 'agent_switched_branch' ||
      f.text === 'agent_modified_protected_branch' ||
      f.text === 'agent_modified_other_goal'
  );
  if (auditResult.findings.length > 0 && sysFindings.length === auditResult.findings.length) {
    const notes = Array.from(new Set(auditResult.findings.map((f) => f.text)));
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes,
    };
  }

  // Audit failed! PM turn with auditFindings
  {
    const pick = await pickSeatAgent('pm', ctx.pmAgent);
    if (pick.agent === null) {
      d.store.recordHandoffFailure(sessionId, 'pm', pick.notes[0] ?? 'gate');
      return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
    }
    ctx.pmAgent = pick.agent;
    ctx.pmAuthor = authorForAgent(ctx.pmAgent);
  }
  if (isOutOfTurns(d.store, sessionId, d.cfg, 'pm')) {
    return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns for PM'] };
  }

  const pmFixTurnId = d.store.startTurn(sessionId, 'pm', ctx.pmAgent, null);
  const pmFixLogFile = join(d.logDir, `turn-${pmFixTurnId}.log`);
  d.store.setTurnLog(pmFixTurnId, pmFixLogFile);

  const seq = d.store.nextTicketSeq(d.repo);
  const nextId = `${key}-${String(seq).padStart(4, '0')}`;
  const pmFixPromptText = pmTicketPrompt({ n: goal.n, title: goal.title }, key, nextId, {
    auditFindings: auditResult.findings,
    hasOpenspec: existsSync(join(d.repo, 'openspec')),
  });

  const pmFixSnapshot = snapshotTurn(d.repo, goal.branch, baseBranch, d.store, 'pm');
  if (pmFixSnapshot.protectedBranchMoved) {
    d.store.endTurn(pmFixTurnId, 'rejected', 'protected_branch_moved');
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [
        `protected_branch_moved: ${pmFixSnapshot.protectedHead} → ${pmFixSnapshot.protectedBranchActualSha ?? ''}`,
        'protected_branch_moved',
      ],
    };
  }
  const recordedBeforeFix = recordExistingTickets(d.repo);
  const prePmFixStatus = new Set(getWorkingTreeChanges(d.repo));

  let pmFixOutput;
  try {
    pmFixOutput = await d.runner('pm', ctx.pmAgent, pmFixPromptText, d.repo, pmFixLogFile, { signal: d.signal });
  } catch (err) {
    const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
    const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
    d.store.endTurn(pmFixTurnId, 'error', reason);
    const pmFixGuard = guardStoredAgentTurn(d.store, d.repo, pmFixSnapshot, 'pm', {
      isErrorOrTimeoutOrAbort: true,
    });
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    if (pmFixGuard.gitConfigTampered) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
    }
    if (pmFixGuard.modifiedProtectedBranch) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
    }
    if (pmFixGuard.protectedBranchMoved) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
    }
    if (pmFixGuard.modifiedOtherGoal) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
    }
    if (isAbort) {
      return { status: 'stopped', sessionId, tasks, notes: [reason] };
    }
    return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
  }

  if (pmFixOutput.timedOut || pmFixOutput.exitCode !== 0 || d.signal?.aborted) {
    const isAbort = Boolean(d.signal?.aborted);
    const reason = isAbort ? 'aborted' : (pmFixOutput.timedOut ? 'timeout' : `exit_${pmFixOutput.exitCode}`);
    d.store.endTurn(pmFixTurnId, isAbort || pmFixOutput.timedOut ? (isAbort ? 'error' : 'timeout') : 'error', reason);
    const pmFixGuard = guardStoredAgentTurn(d.store, d.repo, pmFixSnapshot, 'pm', {
      isErrorOrTimeoutOrAbort: true,
    });
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    if (pmFixGuard.gitConfigTampered) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
    }
    if (pmFixGuard.modifiedProtectedBranch) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
    }
    if (pmFixGuard.protectedBranchMoved) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
    }
    if (pmFixGuard.modifiedOtherGoal) {
      return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
    }
    if (isAbort) {
      return { status: 'stopped', sessionId, tasks, notes: [reason] };
    }
    return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
  }
  const pmFixGuard = guardStoredAgentTurn(d.store, d.repo, pmFixSnapshot, 'pm');
  d.store.endTurn(pmFixTurnId, 'ok');

  if (pmFixGuard.gitConfigTampered) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return { status: 'needs_owner', sessionId, tasks, notes: ['git_config_tampered'] };
  }
  if (pmFixGuard.modifiedProtectedBranch) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_protected_branch'] };
  }
  if (pmFixGuard.protectedBranchMoved) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return { status: 'needs_owner', sessionId, tasks, notes: ['protected_branch_moved'] };
  }
  if (pmFixGuard.modifiedOtherGoal) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return { status: 'needs_owner', sessionId, tasks, notes: ['agent_modified_other_goal'] };
  }
  if (pmFixGuard.switchedBranch) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return { status: 'needs_owner', sessionId, tasks, notes: ['agent_switched_branch'] };
  }

  if (pmModifiedExistingTickets(d.repo, recordedBeforeFix)) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return { status: 'needs_owner', sessionId, tasks, notes: ['pm_modified_existing_ticket'] };
  }

  const postPmFixStatus = getWorkingTreeChanges(d.repo);
  const pmFixChanged = postPmFixStatus.filter((p) => !prePmFixStatus.has(p));
  const pmFixOutOfScope = pmFixChanged.filter((p) => !p.startsWith('team/tickets/'));
  if (pmFixOutOfScope.length > 0) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return { status: 'needs_owner', sessionId, tasks, notes: ['pm_out_of_scope'] };
  }

  let allGoalTicketsNow: Ticket[] = [];
  try {
    allGoalTicketsNow = loadTickets(d.repo, key);
  } catch (err: any) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [`PM ticket error: ${err?.message || String(err)}`],
    };
  }

  const newTickets = allGoalTicketsNow.filter((t) => !recordedBeforeFix.files.has(`${t.id}.md`));
  if (newTickets.length === 0) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [`PM ticket error: No new tickets created by PM for goal G${goal.n}`],
    };
  }
  if (newTickets.some((t) => t.goal !== `G${goal.n}`)) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: ['pm_ticket_wrong_goal'],
    };
  }

  const numParts = newTickets.map((t) => {
    const parts = t.id.split('-');
    return parts.length === 2 && parts[0] === key ? parseInt(parts[1], 10) : NaN;
  });
  numParts.sort((a, b) => a - b);
  const isSequential = numParts.every((num, idx) => num === seq + idx);
  if (!isSequential) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: ['pm_ticket_id_not_sequential'],
    };
  }
  const allGoalTicketsForGoal = allGoalTicketsNow.filter((t) => t.goal === `G${goal.n}`);
  if (hasInvalidDependsOn(newTickets, allGoalTicketsForGoal, `G${goal.n}`, key)) {
    cleanupPmWorkingTree(d.repo, recordedBeforeFix, prePmFixStatus);
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: ['pm_ticket_bad_depends'],
    };
  }

  let maxUsed = seq;
  for (const t of newTickets) {
    d.store.upsertTicket(d.repo, t);
    d.store.setTicketState(d.repo, t.id, 'pending', ctx.pmAgent, 'PM created ticket from audit', 0);
    tasks[t.id] = 'pending';
    const num = parseInt(t.id.split('-')[1], 10);
    if (num > maxUsed) maxUsed = num;
  }
  d.store.bumpTicketSeq(d.repo, maxUsed);

  const firstId = newTickets[0].id;
  const lastId = newTickets[newTickets.length - 1].id;
  commitAll(d.repo, `${firstId}..${lastId}: PM tickets from audit for G${goal.n}`, ctx.pmAuthor);
  return 'again';
}
