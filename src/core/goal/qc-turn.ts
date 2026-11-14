// Lượt QC của một ticket (tách khỏi runTickets 2026-11-14, không đổi hành vi).
import { standardsFor } from '../../standards.ts';
import { regressionTickets } from '../../knowledge/map.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '../../ticket/ticket.ts';
import { commitAll } from '../../git.ts';
import { parseTicketQcResult } from '../../qc/result.ts';
import { cleanConfirmItems } from '../../qc/questions.ts';
import { qcTicketPrompt } from '../prompts.ts';
import { snapshotTurn, guardStoredAgentTurn } from '../guard.ts';
import { authorForAgent, isOutOfTurns } from '../session-helpers.ts';
import type { SessionOutcome } from '../session.ts';
import type { GoalCtx } from './ctx.ts';
import { erroredGuardNote, failMaxFixRounds, type TicketRun } from './ticket-run.ts';

/** QC xem base..HEAD. 'passed' = ticket xong; 'returned' = trả Dev sửa vòng sau; SessionOutcome = goal dừng. */
export async function runQcTurn(
  ctx: GoalCtx,
  run: TicketRun,
  goalTickets: Ticket[],
  base: string,
  primary: string,
): Promise<SessionOutcome | 'passed' | 'returned'> {
  const { d, sessionId, goal, tasks, baseBranch, ownerAnswers, askQuestions, backupsFor, pickSeatAgent } = ctx;
  const { ticket, coders } = run;
  // Rule 8: coder_cannot_qc_same_task
  let qcAgent = primary;
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
  const qcPromptText = qcTicketPrompt(ticket, base, qcAgent, ownerAnswers(ticket.id), regressionTickets(d.repo, ticket), standardsFor(d.store));
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
      images: run.images,
    });
  } catch (err) {
    const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
    const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
    d.store.endTurn(qcTurnId, 'error', reason);
    const note = erroredGuardNote(guardStoredAgentTurn(d.store, d.repo, qcSnapshot, 'qc', { isErrorOrTimeoutOrAbort: true }));
    if (note) return { status: 'needs_owner', sessionId, tasks, notes: [note] };
    if (isAbort) {
      return { status: 'stopped', sessionId, tasks, notes: [reason] };
    }
    return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
  }

  if (qcOutput.timedOut || qcOutput.exitCode !== 0) {
    const reason = qcOutput.timedOut ? 'timeout' : `exit_${qcOutput.exitCode}`;
    d.store.endTurn(qcTurnId, qcOutput.timedOut ? 'timeout' : 'error', reason);
    const note = erroredGuardNote(guardStoredAgentTurn(d.store, d.repo, qcSnapshot, 'qc', { isErrorOrTimeoutOrAbort: true }));
    return { status: 'needs_owner', sessionId, tasks, notes: [note ?? reason] };
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
    d.store.setTicketState(d.repo, ticket.id, 'passed', qcAgent, 'qc passed', run.fixRounds, base);
    return 'passed';
  }

  // QC fail mà không có lỗi/việc cần sửa, chỉ có mục "cần xác nhận" (vd sandbox không mở được cổng):
  // không trả về Dev (Dev không có gì để sửa → lặp tốn lượt). Hỏi anh; anh trả lời rồi Resume thì QC chạy lại.
  if (qcResult.bugs.length === 0 && qcResult.fix.length === 0) {
    const confirmItems = cleanConfirmItems(qcResult.confirm);
    if (confirmItems.length > 0) {
      const newQ = askQuestions(ticket.id, 'qc', qcAgent, confirmItems);
      d.store.setTicketState(d.repo, ticket.id, 'awaiting_qc', 'core', 'qc_needs_confirm', run.fixRounds, base);
      tasks[ticket.id] = 'awaiting_qc';
      return newQ > 0
        ? { status: 'needs_owner', sessionId, tasks, notes: [`questions_open:${newQ}`, `QC for ${ticket.id} needs your confirmation`] }
        : { status: 'needs_owner', sessionId, tasks, notes: ['qc_confirm_unresolved', `QC still cannot confirm ${ticket.id} after your answers`] };
    }
  }

  run.fixRounds++;
  run.fixNotes = [...qcResult.bugs, ...qcResult.fix];
  if (run.fixRounds > d.cfg.turn.max_fix_rounds) {
    return failMaxFixRounds(ctx, run, goalTickets, qcAgent, run.fixNotes.join(', '));
  }
  d.store.setTicketState(d.repo, ticket.id, 'returned', qcAgent, run.fixNotes.join('; '), run.fixRounds, base);
  tasks[ticket.id] = 'returned';
  return 'returned';
}
