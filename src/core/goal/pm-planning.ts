// Lượt PM lập ticket cho goal (tách khỏi processGoal 2026-11-14, không đổi hành vi).
import { lessonsForPrompt } from '../../knowledge/lessons.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTickets, type Ticket, TicketError } from '../../ticket/ticket.ts';
import { commitAll } from '../../git.ts';
import { pmTicketPrompt } from '../prompts.ts';
import { snapshotTurn, guardStoredAgentTurn } from '../guard.ts';
import { authorForAgent, cleanupPmWorkingTree, getWorkingTreeChanges, hasInvalidDependsOn, isOutOfTurns, pmModifiedExistingTickets, recordExistingTickets } from '../session-helpers.ts';
import type { SessionOutcome } from '../session.ts';
import type { GoalCtx } from './ctx.ts';

/** Lượt PM lập ticket cho goal (khi goal chưa có ticket). null = đi tiếp. */
export async function runPmPlanning(ctx: GoalCtx): Promise<SessionOutcome | null> {
  const { d, sessionId, goal, key, tasks, attachedNote, baseBranch, pickSeatAgent } = ctx;
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
      lessons: lessonsForPrompt(d.cfg.host.data_dir, key),
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

