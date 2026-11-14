// Lượt Dev + gate của một ticket (tách khỏi runTickets 2026-11-14, không đổi hành vi).
import { standardsFor } from '../../standards.ts';
import { mapForScope } from '../../knowledge/map.ts';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadTickets, type Ticket } from '../../ticket/ticket.ts';
import { runGate } from '../../gate/gate.ts';
import { accountLastKey } from '../../agents/accounts.ts';
import { git, commitAll } from '../../git.ts';
import { parseReportQuestions } from '../../qc/questions.ts';
import { devTicketPrompt } from '../prompts.ts';
import { snapshotTurn, guardStoredAgentTurn } from '../guard.ts';
import { authorForAgent, isOutOfTurns, readReport, restoreTicketFilesFromBase } from '../session-helpers.ts';
import type { TurnResult } from '../../store/types.ts';
import type { SessionOutcome } from '../session.ts';
import type { GoalCtx } from './ctx.ts';
import { erroredGuardNote, failMaxFixRounds, type TicketRun } from './ticket-run.ts';

/**
 * Dev code ticket rồi chạy gate. 'again' = ticket về returned, Dev làm lại vòng sau;
 * { readyBy } = sẵn sàng cho QC (agent đã code); SessionOutcome = goal dừng.
 */
export async function runDevTurn(
  ctx: GoalCtx,
  run: TicketRun,
  goalTickets: Ticket[],
  base: string,
  primary: string,
): Promise<SessionOutcome | 'again' | { readyBy: string }> {
  const { d, sessionId, goal, key, tasks, baseBranch, askQuestions, pickSeatAgent } = ctx;
  const { ticket } = run;
  let devAgent = primary;
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

  {
    const pick = await pickSeatAgent('dev', devAgent);
    if (pick.agent === null) {
      d.store.recordHandoffFailure(sessionId, ticket.id, pick.notes[0] ?? 'gate');
      return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
    }
    devAgent = pick.agent;
    devAuthor = authorForAgent(devAgent);
  }
  run.coders.add(devAgent);

  if (isOutOfTurns(d.store, sessionId, d.cfg, 'dev')) {
    return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns'] };
  }

  d.store.setTicketState(d.repo, ticket.id, 'in_dev', devAgent, 'dev started', run.fixRounds, base);
  tasks[ticket.id] = 'in_dev';

  const devTurnId = d.store.startTurn(sessionId, 'dev', devAgent, ticket.id);
  const devLogFile = join(d.logDir, `turn-${devTurnId}.log`);
  d.store.setTurnLog(devTurnId, devLogFile);

  const devPromptText = devTicketPrompt(
    ticket,
    devAgent,
    run.fixNotes,
    d.cfg.runner.agy_allow_commands,
    isHandoffFor(devAgent),
    mapForScope(d.repo, ticket.scope),
    standardsFor(d.store)
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
  // Lượt lỗi/timeout/huỷ: vẫn chạy guard để vi phạm của agent không bị lý do lỗi che mất.
  const endFailed = (result: TurnResult, reason: string, status: SessionOutcome['status']): SessionOutcome => {
    d.store.endTurn(devTurnId, result, reason);
    const note = erroredGuardNote(guardStoredAgentTurn(d.store, d.repo, devSnapshot, 'dev', {
      isErrorOrTimeoutOrAbort: true,
      taskId: ticket.id,
      author: devAuthor,
      reason,
    }));
    return note ? { status: 'needs_owner', sessionId, tasks, notes: [note] } : { status, sessionId, tasks, notes: [reason] };
  };
  let devOutput;
  try {
    devOutput = await d.runner('dev', devAgent, devPromptText, d.repo, devLogFile, {
      signal: d.signal,
      images: run.images,
    });
  } catch (err) {
    const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
    const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
    return endFailed('error', reason, isAbort ? 'stopped' : 'needs_owner');
  }

  if (d.signal?.aborted) {
    return endFailed('error', 'aborted', 'stopped');
  }

  if (devOutput.timedOut) {
    return endFailed('timeout', 'timeout', 'needs_owner');
  }

  const hasAutoDenied =
    (devOutput.output || '').includes('auto-denied') ||
    (devOutput.lastMessage || '').includes('auto-denied');

  if (!hasAutoDenied && devOutput.exitCode !== 0) {
    return endFailed('error', `exit_${devOutput.exitCode}`, 'needs_owner');
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
    run.fixNotes = ['agent_switched_branch'];
    run.fixRounds++;
    if (run.fixRounds > d.cfg.turn.max_fix_rounds) {
      return failMaxFixRounds(ctx, run, goalTickets, devAgent, 'agent_switched_branch');
    }
    d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, 'agent_switched_branch', run.fixRounds, base);
    tasks[ticket.id] = 'returned';
    return 'again';
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
      d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, 'questions_open', run.fixRounds, base);
      tasks[ticket.id] = 'returned';
      return { status: 'needs_owner', sessionId, tasks, notes: [`questions_open:${blockedQ}`, `Ticket ${ticket.id} waits for your answers`] };
    }
    tasks[ticket.id] = 'blocked';
    d.store.setTicketState(d.repo, ticket.id, 'blocked', devAgent, 'Dev reported BLOCKED', run.fixRounds, base);
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
    d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, 'questions_open', run.fixRounds, base);
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
    run.fixNotes = [
      ...(hasAutoDenied ? [deniedNote] : []),
      ...(!gateResult.ok ? gateResult.reasons : []),
    ];
    run.fixRounds++;
    if (run.fixRounds > d.cfg.turn.max_fix_rounds) {
      return failMaxFixRounds(ctx, run, goalTickets, devAgent, failureReasons.join(', '));
    }
    d.store.setTicketState(d.repo, ticket.id, 'returned', devAgent, failureReasons.join('; '), run.fixRounds, base);
    tasks[ticket.id] = 'returned';
    return 'again';
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
  return { readyBy: devAgent };
}
