import { READ_ONLY_SEATS } from '../runner/argv.ts';
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
import { accountLastKey, isUsable, pickAccount, seatOpts, slugOfKey, soonestReset, usableAccounts } from '../agents/accounts.ts';
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
import type { GoalCtx } from './goal/ctx.ts';
import { runPmPlanning } from './goal/pm-planning.ts';
import { runTickets } from './goal/tickets.ts';
import { runAuditPhase } from './goal/audit.ts';

export {
  type TurnGuardSnapshot,
  type GuardTurnResult,
  snapshotTurn,
  guardAgentTurn,
};

export type TaskState = TicketState;

export interface SessionOutcome {
  status: 'done' | 'awaiting_approval' | 'needs_owner' | 'out_of_turns' | 'refused' | 'stopped';
  sessionId: number | null;
  tasks: Record<string, TicketState>;
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
  /** Plan 7: gửi ntfy (mặc định notify thật; test truyền vào). */
  notify?: (ev: NotifyEvent) => void;
  /** Plan 7: tài khoản pickSeatAgent đã chọn (qua gate energy) cho từng agent; runner dùng lại. */
  chosenAccounts?: Map<string, string>;
}

export interface RunSessionOpts {
  approved?: boolean;
  noteId?: number;
  text?: string;
  image?: { ext: string; bytes: Buffer };
  note?: {
    noteId: number;
    text: string;
    image?: { ext: string; bytes: Buffer };
  };
}

async function processGoal(
  d: SessionDeps,
  sessionId: number,
  goal: { n: number; title: string; branch: string },
  key: string,
  tasks: Record<string, TicketState>,
  o: RunSessionOpts,
  attachedNote: ReturnType<typeof d.store.getNote>
): Promise<SessionOutcome> {
  const refreshFn = d.refresh ?? (d.monitor ? d.monitor.refresh.bind(d.monitor) : undefined);
  const gateFn = d.gate ?? (d.monitor ? d.monitor.gate.bind(d.monitor) : undefined);

  const pmAgent = effectiveSeats(d.cfg, d.store, d.repo).pm;
  const pmAuthor = authorForAgent(pmAgent);

  // Plan 5 Task 7: người chính hết Energy/đăng nhập → người dự phòng (seats_backup) còn Energy và không vi phạm
  // luật cứng (exclude). Không còn ai → phiên dừng với all_agents_exhausted. Không có dự phòng → như cũ.
  // Plan 6 Task 4: lưu câu hỏi mới (bỏ câu đã hỏi trước đó cho ticket này). true = có câu mới → chặn ticket.
  // Câu trả lời của anh cho ticket (cả câu đã dùng ở lượt trước): đi kèm mọi lượt Dev và QC sau đó của ticket.
  function ownerAnswers(ticketId: string): string[] {
    return d.store.listQuestions(d.repo).filter((q) => q.ticket === ticketId && q.answer)
      .map((q) => `Hỏi: ${q.text} → Anh Zon trả lời: ${q.answer}${q.image ? ` (kèm ảnh ${q.image}, đã đính kèm lượt này)` : ''}`);
  }

  // Ảnh anh Zon kèm câu trả lời của ticket: đưa cho agent như ảnh Team note (-i), chỉ file còn trong inbox.
  function answerImages(ticketId: string): string[] {
    const out: string[] = [];
    for (const q of d.store.listQuestions(d.repo)) {
      if (q.ticket !== ticketId || !q.answer || !q.image) continue;
      try {
        const p = answerImagePath(d.repo, q.image);
        if (existsSync(p)) out.push(p);
      } catch {}
    }
    return out;
  }

  function askQuestions(ticketId: string, seat: Seat, agent: string, items: string[]): number {
    const asked = new Set(d.store.listQuestions(d.repo).filter((q) => q.ticket === ticketId).map((q) => q.text));
    const fresh = items.filter((text) => !asked.has(text));
    for (const text of fresh) d.store.addQuestion(d.repo, ticketId, seat, agent, text);
    return fresh.length;
  }

  // Người dự phòng: team/project.yaml (main) ghi đè btm.config.yaml; chỉ agent có ghế đó trong can_sit.
  const projectBackups = readProjectSeats(d.repo, d.cfg.git?.protected_branch || 'main').backups;
  function backupsFor(seat: Seat): string[] {
    const base = projectBackups[seat] ?? d.cfg.seats_backup?.[seat] ?? [];
    // Boss (decision 0003): luôn là người dự phòng cuối của mọi ghế nó ngồi được.
    const boss = Object.keys(d.cfg.agents).filter((a) => d.cfg.agents[a]!.provider === 'zai' && !base.includes(a));
    const list = [...base, ...boss];
    return list.filter((a) => {
      if (!Object.hasOwn(d.cfg.agents, a) || !d.cfg.agents[a]!.can_sit.includes(seat)) return false;
      return pickAccount(d.cfg, d.store, a, new Date(), seatOpts(d.cfg, d.store, seat, d.repo)) !== null;
    });
  }

  async function pickSeatAgent(
    seat: Seat,
    primary: string,
    exclude: Set<string> = new Set()
  ): Promise<{ agent: string } | { agent: null; notes: string[] }> {
    const backups = backupsFor(seat).filter((a) => a !== primary);
    const reasons: string[] = [];
    for (const agent of [primary, ...backups]) {
      if (exclude.has(agent)) {
        reasons.push(`${agent}: hard rule`);
        continue;
      }
      // Plan 7: thử lần lượt tài khoản dùng được của agent (giới hạn/đăng nhập), rồi gate energy theo tài khoản.
      const accounts = usableAccounts(d.cfg, d.store, agent, new Date(), seatOpts(d.cfg, d.store, seat, d.repo));
      if (accounts.length === 0) {
        const resets = soonestReset(d.store, agent);
        reasons.push(resets ? `usage_limited:${agent} resets ${formatHHmm(resets)}` : `usage_limited:${agent}`);
        continue;
      }
      let picked: string | null = null;
      for (const acct of accounts) {
        if (refreshFn && d.cfg.energy.read_on.includes('before_turn')) {
          try {
            await refreshFn([acct.key]);
          } catch {}
        }
        const check = gateFn ? gateFn(acct.key) : ({ ok: true } as const);
        if (check.ok) {
          picked = acct.key;
          break;
        }
        reasons.push(check.reason);
      }
      if (picked) {
        d.chosenAccounts?.set(agent, picked);
        if (agent !== primary) console.log(`seat_substitute:${seat}:${primary}->${agent}`);
        return { agent };
      }
    }
    if (backups.length === 0) return { agent: null, notes: reasons };
    return { agent: null, notes: ['all_agents_exhausted', ...reasons] };
  }

  const baseBranch = d.cfg.git.protected_branch || 'main';

  // 1. Checkout goal/G<n>-<slug>
  const dirtyFiles = getWorkingTreeChanges(d.repo).filter((f) => !f.startsWith('team/inbox/'));
  const dirty = dirtyFiles.length > 0;
  if (dirty) {
    const currentBranch = git(d.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [`dirty_tree_at_start: ${currentBranch}`, 'dirty_tree_at_start'],
    };
  }

  const goalRef = goal.branch.startsWith('refs/heads/') ? goal.branch : `refs/heads/${goal.branch}`;
  const baseRef = baseBranch.startsWith('refs/heads/') ? baseBranch : `refs/heads/${baseBranch}`;

  let branchExists = false;
  try {
    git(d.repo, 'rev-parse', '--verify', goalRef);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    git(d.repo, 'checkout', goal.branch);
  } else {
    const pinnedBaseSha = d.store.getSetting(protectedShaKey(d.repo))?.trim() || '';
    git(d.repo, 'checkout', '-b', goal.branch, pinnedBaseSha || baseRef);
  }
  const currentHeadSym = git(d.repo, 'symbolic-ref', 'HEAD').trim();
  if (currentHeadSym !== goalRef) {
    throw new Error(`Checkout failed: HEAD is ${currentHeadSym}, expected ${goalRef}`);
  }

  d.store.setGoalState(d.repo, goal.n, 'in_progress', 'core', 'session started');

  // Write attached note if present
  const noteId = o.note?.noteId ?? o.noteId;
  const noteText = o.note?.text ?? o.text;
  const noteImage = o.note?.image ?? o.image;

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

      commitAll(d.repo, `inbox N-${noteId}`, ownerAuthor);
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
      return {
        status: 'needs_owner',
        sessionId,
        tasks,
        notes: [err?.message || String(err)],
      };
    }
  }

  const ctx: GoalCtx = {
    d, sessionId, goal, key, tasks, attachedNote, baseBranch, pmAgent, pmAuthor,
    ownerAnswers, answerImages, askQuestions, backupsFor, pickSeatAgent,
  };

  {
    const r = await runPmPlanning(ctx);
    if (r) return r;
  }

  // 3. Approval check
  const approved = Boolean(o.approved);
  if (!approved && d.cfg.session.require_task_approval) {
    return {
      status: 'awaiting_approval',
      sessionId,
      tasks,
      notes: ['Awaiting task approval'],
    };
  }

  // 4. Work on tickets & Audit
  while (true) {
    if (d.signal?.aborted) {
      return {
        status: 'stopped',
        sessionId,
        tasks,
        notes: ['Session aborted'],
      };
    }

    const goalTickets = loadTickets(d.repo, key, `G${goal.n}`);

  {
    const r = await runTickets(ctx, goalTickets);
    if (r) return r;
  }

  {
    const r = await runAuditPhase(ctx);
    if (r === 'break') break;
    if (r !== 'again') return r;
  }
}

  const finalGoalTickets = loadTickets(d.repo, key, `G${goal.n}`);
  const failedOrBlocked = new Set<string>();
  for (const [id, state] of Object.entries(tasks)) {
    if (state === 'failed' || state === 'blocked') {
      failedOrBlocked.add(id);
    }
  }
  for (const t of finalGoalTickets) {
    const s = d.store.getTicketState(d.repo, t.id);
    if (s?.state === 'failed' || s?.state === 'blocked') {
      failedOrBlocked.add(t.id);
      tasks[t.id] = s.state;
    }
  }

  if (failedOrBlocked.size > 0) {
    const list = Array.from(failedOrBlocked).sort();
    return {
      status: 'needs_owner',
      sessionId,
      tasks,
      notes: [`Unfinished tickets (failed/blocked): ${list.join(', ')}`],
    };
  }

  return {
    status: 'done',
    sessionId,
    tasks,
    notes: [],
  };
}

export async function runSession(
  d: SessionDeps,
  goals: Array<string | { n: number }>,
  optsOrApproved?: boolean | RunSessionOpts
): Promise<SessionOutcome> {
  d = withUsageLimit(d);
  if (recoverInterruptedTurn(d.store, d.repo)) {
    return {
      status: 'needs_owner',
      sessionId: null,
      tasks: {},
      notes: ['recovered_interrupted_turn'],
    };
  }

  const o: RunSessionOpts =
    typeof optsOrApproved === 'boolean'
      ? { approved: optsOrApproved }
      : (optsOrApproved ?? { approved: false });

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

  if (!isRepoInsideProjectsRoot(d.repo, d.cfg)) {
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

  let key: string;
  try {
    key = readProjectKey(d.repo);
  } catch (err: any) {
    return {
      status: 'refused',
      sessionId: null,
      tasks: {},
      notes: [`Cannot read project key: ${err?.message || String(err)}`],
    };
  }

  for (const item of goals) {
    if (typeof item !== 'string') {
      const existing = d.store.getGoal(d.repo, item.n);
      if (!existing) {
        return {
          status: 'needs_owner',
          sessionId: null,
          tasks: {},
          notes: [`Goal G${item.n} not found in project`],
        };
      }
      if (existing.state === 'approved' || existing.state === 'merged') {
        return {
          status: 'needs_owner',
          sessionId: null,
          tasks: {},
          notes: ['goal_already_merged'],
        };
      }
    }
  }

  // 2. Resolve goals and create session
  const resolvedGoals: Array<{ n: number; title: string; branch: string }> = [];
  for (const item of goals) {
    if (typeof item === 'string') {
      const created = d.store.createGoal(d.repo, item);
      resolvedGoals.push({ n: created.n, title: item, branch: created.branch });
    } else {
      const existing = d.store.getGoal(d.repo, item.n);
      if (!existing) {
        return {
          status: 'needs_owner',
          sessionId: null,
          tasks: {},
          notes: [`Goal G${item.n} not found in project`],
        };
      }
      resolvedGoals.push({ n: existing.n, title: existing.title, branch: existing.branch });
    }
  }

  const goalNumbers = resolvedGoals.map((g) => g.n);
  const sessionId = d.store.createSession(goalNumbers as unknown as string[], d.repo);
  let sessionStatus: SessionOutcome['status'] = 'needs_owner';
  const allTasks: Record<string, TicketState> = {};
  const allNotes: string[] = [];
  const processedTickets: Ticket[] = [];

  const noteId = o.note?.noteId ?? o.noteId;
  let attachedNote: ReturnType<typeof d.store.getNote> = null;
  if (noteId) {
    const note = d.store.getNote(noteId);
    if (note && note.project === d.repo) {
      attachedNote = note;
      d.store.setNoteSession(noteId, sessionId);
    }
  }

  try {
    const refreshFn = d.refresh ?? (d.monitor ? d.monitor.refresh.bind(d.monitor) : undefined);
    if (refreshFn && d.cfg.energy.read_on.includes('session_open')) {
      const sittingAgents = Array.from(new Set(Object.values(effectiveSeats(d.cfg, d.store, d.repo))));
      try {
        await refreshFn(sittingAgents);
      } catch {}
    }

    for (const goal of resolvedGoals) {
      const outcome = await processGoal(d, sessionId, goal, key, allTasks, o, attachedNote);
      if (outcome.notes.length > 0) {
        allNotes.push(...outcome.notes);
      }
      try {
        const gTickets = loadTickets(d.repo, key, `G${goal.n}`);
        processedTickets.push(...gTickets);
      } catch {}

      if (outcome.status !== 'done') {
        sessionStatus = outcome.status;
        closeNoteIfEligible(d, sessionId, processedTickets, allTasks, outcome);
        return {
          status: outcome.status,
          sessionId,
          tasks: allTasks,
          notes: allNotes,
        };
      }
    }

    sessionStatus = 'done';
    const finalOutcome: SessionOutcome = {
      status: 'done',
      sessionId,
      tasks: allTasks,
      notes: allNotes,
    };
    closeNoteIfEligible(d, sessionId, processedTickets, allTasks, finalOutcome);
    sessionStatus = finalOutcome.status;
    return finalOutcome;
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
  d = withUsageLimit(d);
  if (recoverInterruptedTurn(d.store, d.repo)) {
    return {
      status: 'needs_owner',
      sessionId,
      tasks: {},
      notes: ['recovered_interrupted_turn'],
    };
  }

  const forbidden = checkForbiddenEnv(d.env, d.cfg.login.forbidden_env);
  if (forbidden.length > 0) {
    return {
      status: 'refused',
      sessionId,
      tasks: {},
      notes: [`Forbidden environment variables: ${forbidden.join(', ')}`],
    };
  }

  if (!isRepoInsideProjectsRoot(d.repo, d.cfg)) {
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
      session.status !== 'stopped' &&
      session.status !== 'out_of_turns')
  ) {
    throw new Error(
      `Session ${sessionId} is not in awaiting_approval, needs_owner, stopped, or out_of_turns status`
    );
  }

  if (session.project && session.project !== d.repo) {
    throw new Error(`Session ${sessionId} belongs to project "${session.project}", not "${d.repo}"`);
  }

  // Resume phiên hết lượt = anh Zon cấp thêm một hạn mức lượt mới (đếm lại từ bây giờ).
  if (session.status === 'out_of_turns') d.store.setSetting(`turns_from:${sessionId}`, new Date().toISOString());
  d.store.setSessionStatus(sessionId, 'running');
  let sessionStatus: SessionOutcome['status'] = 'needs_owner';
  const allTasks: Record<string, TicketState> = {};
  const allNotes: string[] = [];
  const processedTickets: Ticket[] = [];

  try {
    const refreshFn = d.refresh ?? (d.monitor ? d.monitor.refresh.bind(d.monitor) : undefined);
    if (refreshFn && d.cfg.energy.read_on.includes('session_open')) {
      const sittingAgents = Array.from(new Set(Object.values(effectiveSeats(d.cfg, d.store, d.repo))));
      try {
        await refreshFn(sittingAgents);
      } catch {}
    }

    const key = readProjectKey(d.repo);
    const goalNums = session.goals.map((g) => parseInt(g, 10)).filter((n) => !isNaN(n));
    if (goalNums.length === 0) {
      sessionStatus = 'needs_owner';
      return {
        status: 'needs_owner',
        sessionId,
        tasks: {},
        notes: ['no_session_goals'],
      };
    }

    const resolvedGoals: Array<{ n: number; title: string; branch: string }> = [];
    for (const n of goalNums) {
      const g = d.store.getGoal(d.repo, n);
      if (!g) {
        sessionStatus = 'needs_owner';
        return {
          status: 'needs_owner',
          sessionId,
          tasks: {},
          notes: [`Goal G${n} not found in project`],
        };
      }
      if (g.state === 'approved' || g.state === 'merged') {
        try {
          const gTickets = loadTickets(d.repo, key, `G${g.n}`);
          processedTickets.push(...gTickets);
          for (const t of gTickets) {
            const st = d.store.getTicketState(d.repo, t.id);
            if (st) allTasks[t.id] = st.state;
          }
        } catch {}
        continue;
      }
      resolvedGoals.push(g);
    }

    if (resolvedGoals.length === 0) {
      sessionStatus = 'needs_owner';
      return {
        status: 'needs_owner',
        sessionId,
        tasks: allTasks,
        notes: ['goal_already_merged'],
      };
    }

    for (const goal of resolvedGoals) {
      const outcome = await processGoal(d, sessionId, goal, key, allTasks, { approved: true }, null);
      if (outcome.notes.length > 0) {
        allNotes.push(...outcome.notes);
      }
      try {
        const gTickets = loadTickets(d.repo, key, `G${goal.n}`);
        processedTickets.push(...gTickets);
      } catch {}

      if (outcome.status !== 'done') {
        sessionStatus = outcome.status;
        closeNoteIfEligible(d, sessionId, processedTickets, allTasks, outcome);
        return {
          status: outcome.status,
          sessionId,
          tasks: allTasks,
          notes: allNotes,
        };
      }
    }

    sessionStatus = 'done';
    const finalOutcome: SessionOutcome = {
      status: 'done',
      sessionId,
      tasks: allTasks,
      notes: allNotes,
    };
    closeNoteIfEligible(d, sessionId, processedTickets, allTasks, finalOutcome);
    sessionStatus = finalOutcome.status;
    return finalOutcome;
  } finally {
    if (d.signal?.aborted) {
      sessionStatus = 'stopped';
    }
    d.store.setSessionStatus(sessionId, sessionStatus);
  }
}
