import { realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { relative, isAbsolute, join, resolve } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { checkForbiddenEnv } from '../config.ts';
import { effectiveSeats, type Store, type TurnResult, type BoardState } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { parseTaskCard, CardError, type TaskCard } from '../task/card.ts';
import { runGate } from '../gate/gate.ts';
import { git, commitAll, headSha } from '../git.ts';
import { parseQcResult } from '../qc/result.ts';
import { pmPrompt, devPrompt, qcPrompt } from './prompts.ts';
import { inboxPath } from '../server/inbox.ts';

export type TaskState = 'pending' | 'passed' | 'failed' | 'blocked';

export interface SessionOutcome {
  status: 'done' | 'awaiting_approval' | 'needs_owner' | 'out_of_turns' | 'refused' | 'stopped';
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
  logDir: string;
  signal?: AbortSignal;
  gate?: (agent: string) => { ok: true } | { ok: false; reason: string };
  refresh?: (agents: string[], force?: boolean) => Promise<void>;
  monitor?: {
    refresh(agents: string[], force?: boolean): Promise<void>;
    gate(agent: string): { ok: true } | { ok: false; reason: string };
  };
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

function getWorkingTreeChanges(repo: string): string[] {
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

function authorForAgent(agentId: string): { name: string; email: string } {
  return {
    name: agentId,
    email: `${agentId}@btm.local`,
  };
}

function loadCardFromPath(repo: string, relPath: string): TaskCard {
  const filePath = join(repo, relPath);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new CardError(`Cannot read task card file "${filePath}": ${(err as Error).message}`);
  }
  try {
    const card = parseTaskCard(content);
    const fileName = relPath.split('/').pop() ?? relPath;
    const expectedId = fileName.replace(/\.md$/, '');
    if (card.id !== expectedId) {
      throw new CardError(`Task card id "${card.id}" does not match filename "${fileName}"`);
    }
    return card;
  } catch (err) {
    if (err instanceof CardError) {
      throw new CardError(`Error loading "${filePath}": ${err.message}`);
    }
    throw err;
  }
}

async function workOnCards(
  d: SessionDeps,
  sessionId: number,
  cards: TaskCard[],
  tasks: Record<string, TaskState>
): Promise<SessionOutcome> {
  const refreshFn = d.refresh ?? (d.monitor ? d.monitor.refresh.bind(d.monitor) : undefined);
  const gateFn = d.gate ?? (d.monitor ? d.monitor.gate.bind(d.monitor) : undefined);

  for (const card of cards) {
    const taskStates = d.store.listTaskStates(sessionId).filter((s) => s.task_id === card.id);
    const existingState = taskStates.length > 0 ? taskStates[taskStates.length - 1] : undefined;
    const initialTaskState = existingState ? existingState.state : (tasks[card.id] ?? 'pending');

    if (initialTaskState === 'passed' || initialTaskState === 'failed' || initialTaskState === 'blocked') {
      tasks[card.id] = initialTaskState;
      continue;
    }

    let base = existingState?.base_sha || null;
    let fixNotes: string[] = [];
    let fixRounds = existingState ? existingState.fix_rounds : 0;
    if (initialTaskState === 'returned') {
      const reportsDir = join(d.repo, 'team', 'reports');
      const qcReportPath = join(reportsDir, `${card.id}-qc.json`);
      if (existsSync(qcReportPath)) {
        try {
          const qcData = JSON.parse(readFileSync(qcReportPath, 'utf8'));
          if (Array.isArray(qcData.bugs) || Array.isArray(qcData.fix)) {
            fixNotes = [...(qcData.bugs || []), ...(qcData.fix || [])];
          }
        } catch {}
      }
      if (fixNotes.length === 0) {
        const failures = d.store.listHandoffFailures(sessionId).filter((f) => f.task_id === card.id);
        if (failures.length > 0) {
          fixNotes = failures.map((f) => f.reason);
        }
      }
    }

    let skipDevThisRound = (initialTaskState === 'awaiting_qc');
    const coders = new Set<string>();
    for (const t of d.store.listTurns(sessionId)) {
      if (t.seat === 'dev' && t.task_id === card.id && t.agent) {
        coders.add(t.agent);
      }
    }

    let cardImages: string[] | undefined;
    if (card.note) {
      const rawId = card.note.replace(/^N-/, '');
      const noteId = Number(rawId);
      if (!isNaN(noteId)) {
        const note = d.store.getNote(noteId);
        if (note?.image) {
          try {
            const imgPath = inboxPath(d.repo, note.image);
            if (existsSync(imgPath)) {
              cardImages = [imgPath];
            }
          } catch {}
        }
      }
    }

    while (true) {
      const seats = effectiveSeats(d.cfg, d.store);
      const devAgent = Object.hasOwn(seats, 'dev') ? seats.dev : d.cfg.seats.dev;
      const devAuthor = authorForAgent(devAgent);

      const pastDevTurns = d.store
        .listTurns(sessionId)
        .filter((t) => t.seat === 'dev' && t.task_id === card.id);
      const prevCoder = pastDevTurns.length > 0 ? pastDevTurns[pastDevTurns.length - 1].agent : null;

      const currentStates = d.store.listTaskStates(sessionId).filter((s) => s.task_id === card.id);
      const currentState = currentStates.length > 0 ? currentStates[currentStates.length - 1].state : tasks[card.id];
      const isHandoff =
        (currentState === 'returned' || currentState === 'in_dev') &&
        prevCoder !== null &&
        prevCoder !== devAgent;

      if (!skipDevThisRound) {
        if (!base) {
          base = headSha(d.repo);
        }
        coders.add(devAgent);

        if (refreshFn && d.cfg.energy.read_on.includes('before_turn')) {
          try {
            await refreshFn([devAgent]);
          } catch {}
        }
        if (gateFn) {
          const gateCheck = gateFn(devAgent);
          if (!gateCheck.ok) {
            d.store.recordHandoffFailure(sessionId, card.id, gateCheck.reason);
            return { status: 'needs_owner', sessionId, tasks, notes: [gateCheck.reason] };
          }
        }

        if (isOutOfTurns(d.store, sessionId, d.cfg, 'dev')) {
          return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns'] };
        }

        d.store.setTaskState(sessionId, card.id, 'in_dev', fixRounds, base);
        const devTurnId = d.store.startTurn(sessionId, 'dev', devAgent, card.id);
        const devLogFile = join(d.logDir, `turn-${devTurnId}.log`);
        d.store.setTurnLog(devTurnId, devLogFile);
        const devPromptText = devPrompt(card, fixNotes, d.cfg.runner.agy_allow_commands, isHandoff);
        let devOutput;
        try {
          devOutput = await d.runner('dev', devAgent, devPromptText, d.repo, devLogFile, {
            signal: d.signal,
            images: cardImages,
          });
        } catch (err) {
          const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
          const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
          d.store.endTurn(devTurnId, 'error', reason);
          if (isAbort) {
            return { status: 'stopped', sessionId, tasks, notes: [reason] };
          }
          try {
            commitAll(d.repo, `WIP ${card.id}: ${reason}`, devAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        if (devOutput.timedOut) {
          const result: TurnResult = 'timeout';
          const reason = 'timeout';
          d.store.endTurn(devTurnId, result, reason);
          try {
            commitAll(d.repo, `WIP ${card.id}: ${reason}`, devAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        const devText = (devOutput.lastMessage || '') + ' ' + (devOutput.output || '');
        const hasAutoDenied =
          (devOutput.output || '').includes('auto-denied') ||
          (devOutput.lastMessage || '').includes('auto-denied');

        if (!hasAutoDenied && devOutput.exitCode !== 0) {
          const result: TurnResult = 'error';
          const reason = `exit_${devOutput.exitCode}`;
          d.store.endTurn(devTurnId, result, reason);
          try {
            commitAll(d.repo, `WIP ${card.id}: ${reason}`, devAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
        }

        if (devText.includes('BLOCKED')) {
          d.store.endTurn(devTurnId, 'ok');
          try {
            commitAll(d.repo, `${card.id}: blocked`, devAuthor);
          } catch {
            // commitAll error: keep needs_owner, do not throw
          }
          tasks[card.id] = 'blocked';
          d.store.setTaskState(sessionId, card.id, 'blocked', fixRounds, base);
          return { status: 'needs_owner', sessionId, tasks, notes: ['Dev reported BLOCKED'] };
        }

        d.store.endTurn(devTurnId, 'ok');
        try {
          commitAll(d.repo, `${card.id}: dev implementation`, devAuthor);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return { status: 'needs_owner', sessionId, tasks, notes: [`commitAll error: ${reason}`] };
        }

        const timeoutMs = (d.cfg.turn.timeout_minutes.dev ?? 0) * 60 * 1000;
        const gateResult = runGate(d.repo, card, base, d.cfg.gate.commands, {
          timeoutMs,
          require_report_schema: d.cfg.gate.require_report_schema,
        });
        if (!gateResult.ok || hasAutoDenied) {
          const failureReasons: string[] = [];
          if (hasAutoDenied) {
            failureReasons.push('command_denied');
          }
          if (!gateResult.ok) {
            failureReasons.push(...gateResult.reasons);
          }

          d.store.endTurn(devTurnId, 'rejected', failureReasons.join('; '));
          for (const reason of failureReasons) {
            d.store.recordHandoffFailure(sessionId, card.id, reason);
          }

          const deniedNote = 'command_denied: chỉ dùng lệnh trong danh sách, mỗi lệnh riêng lẻ';
          fixNotes = [
            ...(hasAutoDenied ? [deniedNote] : []),
            ...(!gateResult.ok ? gateResult.reasons : []),
          ];
          fixRounds++;
          if (fixRounds > d.cfg.turn.max_fix_rounds) {
            tasks[card.id] = 'failed';
            d.store.setTaskState(sessionId, card.id, 'failed', fixRounds, base);
            return {
              status: 'needs_owner',
              sessionId,
              tasks,
              notes: [
                `Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: ${failureReasons.join(', ')}`,
              ],
            };
          }
          d.store.setTaskState(sessionId, card.id, 'returned', fixRounds, base);
          continue;
        }
      } else {
        skipDevThisRound = false;
        if (!base) {
          base = existingState?.base_sha || headSha(d.repo);
        }
      }

      d.store.setTaskState(sessionId, card.id, 'awaiting_qc', fixRounds, base);

      // Rule 8: coder_cannot_qc_same_task
      const qcAgent = Object.hasOwn(seats, 'qc') ? seats.qc : d.cfg.seats.qc;
      if (d.cfg.rules.coder_cannot_qc_same_task && coders.has(qcAgent)) {
        d.store.recordHandoffFailure(sessionId, card.id, 'coder_cannot_qc_same_task');
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: [
            `Seat 'qc' is occupied by '${qcAgent}', who also coded task '${card.id}'`,
            'coder_cannot_qc_same_task',
          ],
        };
      }

      if (refreshFn && d.cfg.energy.read_on.includes('before_turn')) {
        try {
          await refreshFn([qcAgent]);
        } catch {}
      }
      if (gateFn) {
        const gateCheck = gateFn(qcAgent);
        if (!gateCheck.ok) {
          d.store.recordHandoffFailure(sessionId, card.id, gateCheck.reason);
          return { status: 'needs_owner', sessionId, tasks, notes: [gateCheck.reason] };
        }
      }

      if (isOutOfTurns(d.store, sessionId, d.cfg, 'qc')) {
        return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns'] };
      }

      const qcAuthor = authorForAgent(qcAgent);
      const qcTurnId = d.store.startTurn(sessionId, 'qc', qcAgent, card.id);
      const qcLogFile = join(d.logDir, `turn-${qcTurnId}.log`);
      d.store.setTurnLog(qcTurnId, qcLogFile);
      const qcPromptText = qcPrompt(card, base);
      const preQcHead = headSha(d.repo);
      let qcOutput;
      try {
        qcOutput = await d.runner('qc', qcAgent, qcPromptText, d.repo, qcLogFile, {
          signal: d.signal,
          images: cardImages,
        });
      } catch (err) {
        const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
        const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
        d.store.endTurn(qcTurnId, 'error', reason);
        if (isAbort) {
          return { status: 'stopped', sessionId, tasks, notes: [reason] };
        }
        try {
          commitAll(d.repo, `WIP ${card.id}: ${reason}`, qcAuthor);
        } catch {
          // commitAll error: keep needs_owner, do not throw
        }
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
        return { status: 'needs_owner', sessionId, tasks, notes: [reason] };
      }

      d.store.endTurn(qcTurnId, 'ok');

      let qcResult = parseQcResult(qcOutput.lastMessage);

      // Check if QC modified repository (HEAD changed or working tree dirty)
      const postQcHead = headSha(d.repo);
      const headChanged = postQcHead !== preQcHead;
      const workingTreeDirty = Boolean(git(d.repo, 'status', '--porcelain').trim());

      if (headChanged || workingTreeDirty) {
        qcResult = {
          verdict: 'fail',
          bugs: ['qc_modified_repo'],
          fix: ['qc_modified_repo'],
          confirm: [],
        };
        if (headChanged) {
          git(d.repo, 'reset', '--hard', preQcHead);
        }
        if (workingTreeDirty) {
          git(d.repo, 'reset', 'HEAD', '--', '.');
          git(d.repo, 'checkout', '--', '.');
          git(d.repo, 'clean', '-fd');
        }
      }

      // Save QC result to team/reports/<id>-qc.json and commit (author ghế qc)
      const reportsDir = join(d.repo, 'team', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const qcReportPath = join(reportsDir, `${card.id}-qc.json`);
      writeFileSync(qcReportPath, JSON.stringify(qcResult, null, 2) + '\n', 'utf8');
      try {
        commitAll(d.repo, `${card.id}: qc ${qcResult.verdict}`, qcAuthor);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { status: 'needs_owner', sessionId, tasks, notes: [`commitAll error: ${reason}`] };
      }

      if (qcResult.verdict === 'pass') {
        tasks[card.id] = 'passed';
        d.store.setTaskState(sessionId, card.id, 'passed', fixRounds, base);
        break;
      }

      fixRounds++;
      fixNotes = [...qcResult.bugs, ...qcResult.fix];
      if (fixRounds > d.cfg.turn.max_fix_rounds) {
        tasks[card.id] = 'failed';
        d.store.setTaskState(sessionId, card.id, 'failed', fixRounds, base);
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: [`Max fix rounds (${d.cfg.turn.max_fix_rounds}) exceeded: ${fixNotes.join(', ')}`],
        };
      }
      d.store.setTaskState(sessionId, card.id, 'returned', fixRounds, base);
    }
  }

  const failedOrBlocked = new Set<string>();
  for (const [id, state] of Object.entries(tasks)) {
    if (state === 'failed' || state === 'blocked') {
      failedOrBlocked.add(id);
    }
  }
  for (const s of d.store.listTaskStates(sessionId)) {
    if (s.state === 'failed' || s.state === 'blocked') {
      failedOrBlocked.add(s.task_id);
      if (!tasks[s.task_id]) {
        tasks[s.task_id] = s.state;
      }
    }
  }

  if (failedOrBlocked.size > 0) {
    const list = Array.from(failedOrBlocked).sort();
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [`Các thẻ chưa hoàn thành (failed/blocked): ${list.join(', ')}`],
    };
  }

  return {
    status: 'done',
    sessionId,
    tasks,
    notes: [],
  };
}

function closeNoteIfEligible(
  d: SessionDeps,
  sessionId: number,
  cards: TaskCard[],
  tasks: Record<string, TaskState>,
  outcome: SessionOutcome
): void {
  const sessionNotes = d.store.getNotesBySession(sessionId);
  if (sessionNotes.length === 0) return;

  for (const note of sessionNotes) {
    if (note.status === 'done') continue;
    const cardsForNote = cards.filter(
      (c) => c.note === `N-${note.id}` || c.note === String(note.id)
    );
    const allPassed =
      cardsForNote.length > 0 &&
      cardsForNote.every((c) => tasks[c.id] === 'passed');

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

export interface RunSessionOpts {
  approved: boolean;
  noteId?: number;
  text?: string;
  image?: { ext: string; bytes: Buffer };
  note?: {
    noteId: number;
    text: string;
    image?: { ext: string; bytes: Buffer };
  };
}

export async function runSession(
  d: SessionDeps,
  goals: string[],
  o: RunSessionOpts
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
  const sessionId = d.store.createSession(goals, d.repo);
  let sessionStatus: SessionOutcome['status'] = 'needs_owner';
  const tasks: Record<string, TaskState> = {};

  const noteId = o.note?.noteId ?? o.noteId;
  const noteText = o.note?.text ?? o.text;
  const noteImage = o.note?.image ?? o.image;

  let attachedNote: ReturnType<typeof d.store.getNote> = null;
  if (noteId) {
    const note = d.store.getNote(noteId);
    if (note && note.project === d.repo) {
      attachedNote = note;
      d.store.setNoteSession(noteId, sessionId);
    }
  }

  try {
    const pmAgent = effectiveSeats(d.cfg, d.store).pm;
    const pmAuthor = authorForAgent(pmAgent);

    const dirty = Boolean(git(d.repo, 'status', '--porcelain').trim());
    if (dirty) {
      commitAll(d.repo, `checkpoint before session ${sessionId}`, pmAuthor);
    }

    const baseBranch = d.cfg.git.protected_branch || 'main';
    git(d.repo, 'checkout', '-b', `session/${sessionId}`, baseBranch);
    let sessionBaseSha = headSha(d.repo);

    // Write note and image to branch if provided, before PM turn
    if (noteId && (noteText !== undefined || noteImage !== undefined)) {
      let createdMdPath: string | null = null;
      let createdImgPath: string | null = null;
      try {
        const ownerAuthor = { name: 'owner', email: 'owner@btm.local' };
        let imageName: string | null = null;
        if (noteImage?.ext && noteImage?.bytes) {
          imageName = `N-${noteId}.${noteImage.ext}`;
          if (!attachedNote?.image) {
            d.store.setNoteImage(noteId, imageName);
          }
          const imgPath = inboxPath(d.repo, imageName);
          try {
            lstatSync(imgPath);
            throw new Error(`Target image file already exists: ${imageName}`);
          } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
          }
          writeFileSync(imgPath, noteImage.bytes, { flag: 'wx' });
          createdImgPath = imgPath;
        } else if (attachedNote?.image) {
          imageName = attachedNote.image;
        }

        const rawText = noteText ?? attachedNote?.text ?? '';
        const now = new Date().toISOString();
        const noteMdLines = [
          '---',
          `id: N-${noteId}`,
          'from: owner',
          'status: open',
          `at: ${now}`,
        ];
        if (imageName) {
          noteMdLines.push(`image: ${imageName}`);
        }
        noteMdLines.push('---', rawText, '');

        const mdPath = inboxPath(d.repo, `N-${noteId}.md`);
        try {
          lstatSync(mdPath);
          throw new Error(`Target note file already exists: N-${noteId}.md`);
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
        }
        writeFileSync(mdPath, noteMdLines.join('\n'), { flag: 'wx', encoding: 'utf8' });
        createdMdPath = mdPath;

        try {
          commitAll(d.repo, `inbox N-${noteId}`, ownerAuthor);
        } catch (err: any) {
          throw new Error(`Commit note failed: ${err?.message || String(err)}`);
        }

        sessionBaseSha = headSha(d.repo);
        attachedNote = d.store.getNote(noteId);
      } catch (err: any) {
        if (createdMdPath) {
          try { rmSync(createdMdPath, { force: true }); } catch {}
        }
        if (createdImgPath) {
          try { rmSync(createdImgPath, { force: true }); } catch {}
        }
        try {
          d.store.deleteNote(noteId);
        } catch {}
        sessionStatus = 'needs_owner';
        return {
          status: 'needs_owner',
          sessionId,
          tasks,
          notes: [err?.message || String(err)],
        };
      }
    }

    // 3. PM Turn
    const refreshFn = d.refresh ?? (d.monitor ? d.monitor.refresh.bind(d.monitor) : undefined);
    const gateFn = d.gate ?? (d.monitor ? d.monitor.gate.bind(d.monitor) : undefined);

    if (refreshFn && d.cfg.energy.read_on.includes('session_open')) {
      const sittingAgents = Array.from(new Set(Object.values(effectiveSeats(d.cfg, d.store))));
      try {
        await refreshFn(sittingAgents);
      } catch {}
    }

    if (refreshFn && d.cfg.energy.read_on.includes('before_turn')) {
      try {
        await refreshFn([pmAgent]);
      } catch {}
    }
    if (gateFn) {
      const gateCheck = gateFn(pmAgent);
      if (!gateCheck.ok) {
        d.store.recordHandoffFailure(sessionId, 'pm', gateCheck.reason);
        sessionStatus = 'needs_owner';
        return { status: 'needs_owner', sessionId, tasks, notes: [gateCheck.reason] };
      }
    }

    if (isOutOfTurns(d.store, sessionId, d.cfg, 'pm')) {
      sessionStatus = 'out_of_turns';
      return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns for PM'] };
    }

    const pmTurnId = d.store.startTurn(sessionId, 'pm', pmAgent, null);
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
    const hasOpenspec = existsSync(join(d.repo, 'openspec'));
    const pmPromptText = pmPrompt(goals, promptNotes, hasOpenspec);
    const prePmStatus = new Set(getWorkingTreeChanges(d.repo));
    let pmOutput;
    try {
      pmOutput = await d.runner('pm', pmAgent, pmPromptText, d.repo, pmLogFile, { signal: d.signal });
    } catch (err) {
      const isAbort = d.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
      const reason = isAbort ? 'aborted' : (err instanceof Error ? err.message : String(err));
      d.store.endTurn(pmTurnId, 'error', reason);
      try {
        commitAll(d.repo, `WIP pm: ${reason}`, pmAuthor);
      } catch {
        // commitAll error: keep needs_owner, do not throw
      }
      if (isAbort) {
        sessionStatus = 'stopped';
        return { status: 'stopped', sessionId, tasks, notes: [reason] };
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

    const postPmStatus = getWorkingTreeChanges(d.repo);
    const pmChanged = postPmStatus.filter((p) => !prePmStatus.has(p));
    const pmOutOfScope = pmChanged.filter((p) => !p.startsWith('team/tasks/'));
    if (pmOutOfScope.length > 0) {
      git(d.repo, 'reset', 'HEAD', '--', '.');
      try {
        git(d.repo, 'add', 'team/tasks');
      } catch {}
      if (git(d.repo, 'diff', '--cached', '--name-only').trim()) {
        const authorString = `${pmAuthor.name} <${pmAuthor.email}>`;
        git(
          d.repo,
          '-c',
          `user.name=${pmAuthor.name}`,
          '-c',
          `user.email=${pmAuthor.email}`,
          'commit',
          `--author=${authorString}`,
          '-m',
          'PM: define task cards'
        );
      }
      sessionStatus = 'needs_owner';
      return { status: 'needs_owner', sessionId, tasks, notes: ['pm_out_of_scope'] };
    }

    try {
      commitAll(d.repo, 'PM: define task cards', pmAuthor);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      sessionStatus = 'needs_owner';
      return { status: 'needs_owner', sessionId, tasks, notes: [`commitAll error: ${reason}`] };
    }

    let cards: TaskCard[] = [];
    try {
      const diffOut = git(d.repo, 'diff', '--name-only', '--diff-filter=AMCR', `${sessionBaseSha}..HEAD`, '--', 'team/tasks');
      const changedFiles = diffOut
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter((s) => s.length > 0 && /^team\/tasks\/T-[^/]+\.md$/.test(s));

      if (changedFiles.length === 0) {
        throw new CardError('No task cards created by PM');
      }

      const seenIds = new Set<string>();
      for (const relPath of changedFiles) {
        const card = loadCardFromPath(d.repo, relPath);
        if (seenIds.has(card.id)) {
          throw new CardError(`Duplicate task card id "${card.id}"`);
        }
        seenIds.add(card.id);
        cards.push(card);
      }
      cards.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
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

    d.store.setSessionTasks(sessionId, cards.map((c) => c.id));

    for (const card of cards) {
      tasks[card.id] = 'pending';
      d.store.setTaskState(sessionId, card.id, 'pending', 0);
    }

    // 4. Require approval check
    if (!o.approved) {
      sessionStatus = 'awaiting_approval';
      return {
        status: 'awaiting_approval',
        sessionId,
        tasks,
        notes: ['Awaiting task approval'],
      };
    }

    // 5. Work on cards
    const outcome = await workOnCards(d, sessionId, cards, tasks);
    closeNoteIfEligible(d, sessionId, cards, tasks, outcome);
    sessionStatus = outcome.status;
    return outcome;
  } finally {
    if (d.signal?.aborted) {
      sessionStatus = 'stopped';
    }
    d.store.setSessionStatus(sessionId, sessionStatus);
  }
}

export async function resumeSession(
  d: SessionDeps,
  sessionId: number
): Promise<SessionOutcome> {
  // 1. Validate environment and repo path
  const forbidden = checkForbiddenEnv(d.env, d.cfg.login.forbidden_env);
  if (forbidden.length > 0) {
    return {
      status: 'refused',
      sessionId,
      tasks: {},
      notes: [`Forbidden environment variables: ${forbidden.join(', ')}`],
    };
  }

  if (!isRepoInsideProjectsRoot(d.repo, d.cfg.host.projects_root)) {
    return {
      status: 'refused',
      sessionId,
      tasks: {},
      notes: [`Repository path is not inside host.projects_root (${d.cfg.host.projects_root})`],
    };
  }

  const session = d.store.getSession(sessionId);
  if (
    !session ||
    (session.status !== 'awaiting_approval' &&
      session.status !== 'needs_owner' &&
      session.status !== 'stopped')
  ) {
    throw new Error(
      `Session ${sessionId} is not in awaiting_approval, needs_owner, or stopped status`
    );
  }

  if (session.project && session.project !== d.repo) {
    throw new Error(`Session ${sessionId} belongs to project "${session.project}", not "${d.repo}"`);
  }

  d.store.setSessionStatus(sessionId, 'running');
  let sessionStatus: SessionOutcome['status'] = 'needs_owner';
  const tasks: Record<string, TaskState> = {};

  try {
    const refreshFn = d.refresh ?? (d.monitor ? d.monitor.refresh.bind(d.monitor) : undefined);
    if (refreshFn && d.cfg.energy.read_on.includes('session_open')) {
      const sittingAgents = Array.from(new Set(Object.values(effectiveSeats(d.cfg, d.store))));
      try {
        await refreshFn(sittingAgents);
      } catch {}
    }

    const sessionTasks = d.store.getSessionTasks(sessionId);
    if (sessionTasks.length === 0) {
      sessionStatus = 'needs_owner';
      return {
        status: 'needs_owner',
        sessionId,
        tasks: {},
        notes: ['no_session_tasks'],
      };
    }

    git(d.repo, 'checkout', `session/${sessionId}`);

    let cards: TaskCard[] = [];
    try {
      const seenIds = new Set<string>();
      for (const taskId of sessionTasks) {
        const relPath = `team/tasks/${taskId}.md`;
        const card = loadCardFromPath(d.repo, relPath);
        if (seenIds.has(card.id)) {
          throw new CardError(`Duplicate task card id "${card.id}"`);
        }
        seenIds.add(card.id);
        cards.push(card);
      }
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

    const existingStates = d.store.listTaskStates(sessionId);
    const existingStateMap = new Map<string, { state: BoardState; fix_rounds: number }>();
    for (const s of existingStates) {
      existingStateMap.set(s.task_id, s);
    }

    for (const card of cards) {
      const existing = existingStateMap.get(card.id);
      if (existing) {
        if (
          existing.state === 'passed' ||
          existing.state === 'failed' ||
          existing.state === 'blocked'
        ) {
          tasks[card.id] = existing.state;
        } else {
          tasks[card.id] = 'pending';
        }
      } else {
        tasks[card.id] = 'pending';
        d.store.setTaskState(sessionId, card.id, 'pending', 0);
      }
    }

    const outcome = await workOnCards(d, sessionId, cards, tasks);
    closeNoteIfEligible(d, sessionId, cards, tasks, outcome);
    sessionStatus = outcome.status;
    return outcome;
  } finally {
    if (d.signal?.aborted) {
      sessionStatus = 'stopped';
    }
    d.store.setSessionStatus(sessionId, sessionStatus);
  }
}
