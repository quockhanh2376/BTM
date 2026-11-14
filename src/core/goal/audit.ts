// Kiểm ticket + Audit + PM sửa theo audit (tách khỏi processGoal 2026-11-14, không đổi hành vi).
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Seat } from '../../config.ts';
import { effectiveSeats } from '../../store/db.ts';
import { loadTickets, type Ticket } from '../../ticket/ticket.ts';
import { git, commitAll } from '../../git.ts';
import { parseAuditResult } from '../../audit/result.ts';
import { pmTicketPrompt, auditPrompt } from '../prompts.ts';
import { snapshotTurn, guardStoredAgentTurn } from '../guard.ts';
import { authorForAgent, cleanupPmWorkingTree, getWorkingTreeChanges, hasInvalidDependsOn, isOutOfTurns, pmModifiedExistingTickets, recordExistingTickets, writeGoalSummaryAndCommit } from '../session-helpers.ts';
import type { SessionOutcome } from '../session.ts';
import type { GoalCtx } from './ctx.ts';

/** Kiểm ticket + Audit; audit fail → PM lập ticket sửa. 'again' = chạy lại vòng ticket; 'break' = sang kiểm tra cuối. */
export async function runAuditPhase(ctx: GoalCtx): Promise<SessionOutcome | 'again' | 'break'> {
  const { d, sessionId, goal, key, tasks, baseBranch, backupsFor, pickSeatAgent } = ctx;
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
