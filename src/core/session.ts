import { realpathSync } from 'node:fs';
import { relative, isAbsolute, join } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { checkForbiddenEnv } from '../config.ts';
import type { Store, TurnResult } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { loadTaskCards, CardError, type TaskCard } from '../task/card.ts';
import { runGate } from '../gate/gate.ts';
import { git, commitAll, headSha } from '../git.ts';
import { parseQcResult } from '../qc/result.ts';
import { pmPrompt, devPrompt, qcPrompt } from './prompts.ts';

export type TaskState = 'pending' | 'passed' | 'failed' | 'blocked';

export interface SessionOutcome {
  status: 'done' | 'awaiting_approval' | 'needs_owner' | 'out_of_turns' | 'refused';
  sessionId: number | null;
  tasks: Record<string, TaskState>;
  notes: string[];
}

export interface SessionDeps {
  cfg: Config;
  store: Store;
  runner: Runner;
  repo: string;
  env: NodeJS.ProcessEnv;
}

function isRepoInsideProjectsRoot(repo: string, projectsRoot: string): boolean {
  try {
    const realRepo = realpathSync(repo);
    const realRoot = realpathSync(projectsRoot);
    const rel = relative(realRoot, realRepo);
    return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function isOutOfTurns(store: Store, sessionId: number, cfg: Config, seat: Seat): boolean {
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

function authorForAgent(agentId: string): { name: string; email: string } {
  return {
    name: agentId,
    email: `${agentId}@btm.local`,
  };
}

export async function runSession(
  d: SessionDeps,
  goals: string[],
  o: { approved: boolean }
): Promise<SessionOutcome> {
  // 1. Validate environment, repo path, goals
  const forbidden = checkForbiddenEnv(d.env, d.cfg.login.forbidden_env);
  if (forbidden.length > 0) {
    return {
      status: 'refused',
      sessionId: null,
      tasks: {},
      notes: [`Forbidden environment variables: ${forbidden.join(', ')}`],
    };
  }

  if (!isRepoInsideProjectsRoot(d.repo, d.cfg.host.projects_root)) {
    return {
      status: 'refused',
      sessionId: null,
      tasks: {},
      notes: [`Repository path is not inside host.projects_root (${d.cfg.host.projects_root})`],
    };
  }

  if (goals.length < 1 || goals.length > d.cfg.session.max_goals) {
    return {
      status: 'refused',
      sessionId: null,
      tasks: {},
      notes: [`Invalid goals count ${goals.length}; allowed 1..${d.cfg.session.max_goals}`],
    };
  }

  // 2. Create session and checkout session/<id> branch
  const sessionId = d.store.createSession(goals);
  let sessionStatus: SessionOutcome['status'] = 'needs_owner';
  const tasks: Record<string, TaskState> = {};

  try {
    const baseBranch = d.cfg.git.protected_branch || 'main';
    git(d.repo, 'checkout', '-b', `session/${sessionId}`, baseBranch);

    // 3. PM Turn
    const pmAgent = d.cfg.seats.pm;
    const pmAuthor = authorForAgent(pmAgent);

    if (isOutOfTurns(d.store, sessionId, d.cfg, 'pm')) {
      sessionStatus = 'out_of_turns';
      return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns for PM'] };
    }

    const pmTurnId = d.store.startTurn(sessionId, 'pm', pmAgent, null);
    const pmPromptText = pmPrompt(goals);
    let pmOutput;
    try {
      pmOutput = await d.runner('pm', pmAgent, pmPromptText, d.repo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      d.store.endTurn(pmTurnId, 'error', reason);
      try {
        commitAll(d.repo, `WIP pm: ${reason}`, pmAuthor);
      } catch {
        // commitAll error: keep needs_owner, do not throw
      }
      sessionStatus = 'needs_owner';
      return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
    }

    if (pmOutput.timedOut || pmOutput.exitCode !== 0) {
      const result: TurnResult = pmOutput.timedOut ? 'timeout' : 'error';
      const reason = pmOutput.timedOut ? 'timeout' : `exit_${pmOutput.exitCode}`;
      d.store.endTurn(pmTurnId, result, reason);
      try {
        commitAll(d.repo, `WIP pm: ${reason}`, pmAuthor);
      } catch {
        // commitAll error: keep needs_owner, do not throw
      }
      sessionStatus = 'needs_owner';
      return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
    }
    d.store.endTurn(pmTurnId, 'ok');

    try {
      commitAll(d.repo, 'PM: define task cards', pmAuthor);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      sessionStatus = 'needs_owner';
      return { status: 'needs_owner', sessionId, tasks, notes: [`commitAll error: ${reason}`] };
    }

    const tasksDir = join(d.repo, 'team', 'tasks');
    let cards: TaskCard[];
    try {
      cards = loadTaskCards(tasksDir);
      if (cards.length === 0) {
        throw new CardError('No task cards created by PM');
      }
    } catch (err) {
      if (err instanceof CardError) {
        sessionStatus = 'needs_owner';
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: [`CardError: ${err.message}`],
        };
      }
      throw err;
    }

    for (const card of cards) {
      tasks[card.id] = 'pending';
    }

    // 4. Require approval check
    if (d.cfg.session.require_task_approval && !o.approved) {
      sessionStatus = 'awaiting_approval';
      return {
        status: 'awaiting_approval',
        sessionId,
        tasks,
        notes: ['Awaiting task approval'],
      };
    }

    // 5. Work on cards
    for (const card of cards) {
      const base = headSha(d.repo);
      let fixNotes: string[] = [];
      let fixRounds = 0;
      const coders = new Set<string>();

      while (true) {
        const devAgent = d.cfg.seats.dev;
        const devAuthor = authorForAgent(devAgent);
        coders.add(devAgent);

        if (isOutOfTurns(d.store, sessionId, d.cfg, 'dev')) {
          sessionStatus = 'out_of_turns';
          return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns'] };
        }

        const devTurnId = d.store.startTurn(sessionId, 'dev', devAgent, card.id);
        const devPromptText = devPrompt(card, fixNotes);
        let devOutput;
        try {
          devOutput = await d.runner('dev', devAgent, devPromptText, d.repo);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          d.store.endTurn(devTurnId, 'error', reason);
          try {
            commitAll(d.repo, `WIP ${card.id}: ${reason}`, devAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          sessionStatus = 'needs_owner';
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        if (devOutput.timedOut || devOutput.exitCode !== 0) {
          const result: TurnResult = devOutput.timedOut ? 'timeout' : 'error';
          const reason = devOutput.timedOut ? 'timeout' : `exit_${devOutput.exitCode}`;
          d.store.endTurn(devTurnId, result, reason);
          try {
            commitAll(d.repo, `WIP ${card.id}: ${reason}`, devAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          sessionStatus = 'needs_owner';
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        const devText = (devOutput.lastMessage || '') + ' ' + (devOutput.output || '');
        if (devText.includes('BLOCKED')) {
          d.store.endTurn(devTurnId, 'ok');
          try {
            commitAll(d.repo, `${card.id}: blocked`, devAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          tasks[card.id] = 'blocked';
          sessionStatus = 'needs_owner';
          return { status: 'needs_owner', sessionId, tasks, notes: ['Dev reported BLOCKED'] };
        }

        d.store.endTurn(devTurnId, 'ok');
        try {
          commitAll(d.repo, `${card.id}: dev implementation`, devAuthor);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          sessionStatus = 'needs_owner';
          return { status: 'needs_owner', sessionId, tasks, notes: [`commitAll error: ${reason}`] };
        }

        const gateResult = runGate(d.repo, card, base, d.cfg.gate.commands);
        if (!gateResult.ok) {
          d.store.endTurn(devTurnId, 'rejected', gateResult.reasons.join('; '));
          for (const reason of gateResult.reasons) {
            d.store.recordHandoffFailure(sessionId, card.id, reason);
          }
          fixNotes = [...gateResult.reasons];
          fixRounds++;
          if (fixRounds > d.cfg.turn.max_fix_rounds) {
            tasks[card.id] = 'failed';
            sessionStatus = 'needs_owner';
            return {
              status: 'needs_owner',
              sessionId,
              tasks,
              notes: [
                `Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: ${gateResult.reasons.join(', ')}`,
              ],
            };
          }
          continue;
        }

        // Rule 8: coder_cannot_qc_same_task
        const qcAgent = d.cfg.seats.qc;
        if (d.cfg.rules.coder_cannot_qc_same_task && coders.has(qcAgent)) {
          sessionStatus = 'needs_owner';
          return {
            status: 'needs_owner',
            sessionId,
            tasks,
            notes: [`Seat 'qc' is occupied by '${qcAgent}', who also coded task '${card.id}'`],
          };
        }

        if (isOutOfTurns(d.store, sessionId, d.cfg, 'qc')) {
          sessionStatus = 'out_of_turns';
          return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns'] };
        }

        const qcAuthor = authorForAgent(qcAgent);
        const qcTurnId = d.store.startTurn(sessionId, 'qc', qcAgent, card.id);
        const qcPromptText = qcPrompt(card, base);
        let qcOutput;
        try {
          qcOutput = await d.runner('qc', qcAgent, qcPromptText, d.repo);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          d.store.endTurn(qcTurnId, 'error', reason);
          try {
            commitAll(d.repo, `WIP ${card.id}: ${reason}`, qcAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          sessionStatus = 'needs_owner';
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        if (qcOutput.timedOut || qcOutput.exitCode !== 0) {
          const result: TurnResult = qcOutput.timedOut ? 'timeout' : 'error';
          const reason = qcOutput.timedOut ? 'timeout' : `exit_${qcOutput.exitCode}`;
          d.store.endTurn(qcTurnId, result, reason);
          try {
            commitAll(d.repo, `WIP ${card.id}: ${reason}`, qcAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          sessionStatus = 'needs_owner';
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        d.store.endTurn(qcTurnId, 'ok');

        const qcResult = parseQcResult(qcOutput.lastMessage);
        if (qcResult.verdict === 'pass') {
          tasks[card.id] = 'passed';
          break;
        }

        fixRounds++;
        fixNotes = [...qcResult.bugs, ...qcResult.fix];
        if (fixRounds > d.cfg.turn.max_fix_rounds) {
          tasks[card.id] = 'failed';
          sessionStatus = 'needs_owner';
          return {
            status: 'needs_owner',
            sessionId,
            tasks,
            notes: [`Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: ${fixNotes.join(', ')}`],
          };
        }
      }
    }

    sessionStatus = 'done';
    return {
      status: 'done',
      sessionId,
      tasks,
      notes: [],
    };
  } finally {
    d.store.setSessionStatus(sessionId, sessionStatus);
  }
}
