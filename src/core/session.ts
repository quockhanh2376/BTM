import { realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, readdirSync } from 'node:fs';
import { relative, isAbsolute, join, basename } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { checkForbiddenEnv } from '../config.ts';
import { effectiveSeats, type Store, type TurnResult } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { loadTickets, checkReady, type Ticket, type TicketState, TicketError } from '../ticket/ticket.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { runGate } from '../gate/gate.ts';
import { git, commitAll, headSha } from '../git.ts';
import { parseTicketQcResult } from '../qc/result.ts';
import { parseAuditResult } from '../audit/result.ts';
import { pmTicketPrompt, devTicketPrompt, qcTicketPrompt, auditPrompt } from './prompts.ts';
import { inboxPath } from '../server/inbox.ts';
import {
  type TurnGuardSnapshot,
  type GuardTurnResult,
  snapshotTurn,
  guardAgentTurn,
  guardStoredAgentTurn,
  recoverInterruptedTurn,
  protectedShaKey,
} from './guard.ts';

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

function isInside(repo: string, root: string): boolean {
  try {
    const rel = relative(realpathSync(root), realpathSync(repo));
    return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

// Cách ly: project của store là checkout tin cậy dưới host.trusted_root.
function isRepoInsideProjectsRoot(repo: string, cfg: Config): boolean {
  return isInside(repo, cfg.host.projects_root) || Boolean(cfg.host.worker_prefix && cfg.host.trusted_root && isInside(repo, cfg.host.trusted_root));
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

function parseTicketIdNumber(id: string, key: string): number {
  const parts = id.split('-');
  return parts.length === 2 && parts[0] === key ? parseInt(parts[1], 10) : NaN;
}

function hasInvalidDependsOn(
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

function writeGoalSummaryAndCommit(
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
    '| # | Ticket | Tiêu đề | Trạng thái | Vòng sửa |',
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

function closeNoteIfEligible(
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

interface RecordedTickets {
  files: Set<string>;
  contents: Map<string, string>;
}



function recordExistingTickets(repo: string): RecordedTickets {
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

function restoreExistingTickets(repo: string, recorded: RecordedTickets): void {
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

function cleanupPmWorkingTree(repo: string, recorded: RecordedTickets, prePmStatus?: Set<string>): void {
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

function restoreTicketFilesFromBase(repo: string, base: string): void {
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

function pmModifiedExistingTickets(repo: string, recorded: RecordedTickets): boolean {
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

  let pmAgent = effectiveSeats(d.cfg, d.store, d.repo).pm;
  let pmAuthor = authorForAgent(pmAgent);

  // Plan 5 Task 7: người chính hết Energy/đăng nhập → người dự phòng (seats_backup) còn Energy và không vi phạm
  // luật cứng (exclude). Không còn ai → phiên dừng với all_agents_exhausted. Không có dự phòng → như cũ.
  async function pickSeatAgent(
    seat: Seat,
    primary: string,
    exclude: Set<string> = new Set()
  ): Promise<{ agent: string } | { agent: null; notes: string[] }> {
    const backups = (d.cfg.seats_backup?.[seat] ?? []).filter((a) => a !== primary);
    const reasons: string[] = [];
    for (const agent of [primary, ...backups]) {
      if (exclude.has(agent)) {
        reasons.push(`${agent}: luật cứng`);
        continue;
      }
      if (refreshFn && d.cfg.energy.read_on.includes('before_turn')) {
        try {
          await refreshFn([agent]);
        } catch {}
      }
      const check = gateFn ? gateFn(agent) : ({ ok: true } as const);
      if (check.ok) {
        if (agent !== primary) console.log(`seat_substitute:${seat}:${primary}->${agent}`);
        return { agent };
      }
      reasons.push(check.reason);
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

  // 2. Check if tickets exist for this goal
  let existingGoalTickets = loadTickets(d.repo, key, `G${goal.n}`);

  if (existingGoalTickets.length === 0) {
    // PM Turn
    {
      const pick = await pickSeatAgent('pm', pmAgent);
      if (pick.agent === null) {
        d.store.recordHandoffFailure(sessionId, 'pm', pick.notes[0] ?? 'gate');
        return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
      }
      pmAgent = pick.agent;
      pmAuthor = authorForAgent(pmAgent);
    }

    if (isOutOfTurns(d.store, sessionId, d.cfg, 'pm')) {
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
    const seq = d.store.nextTicketSeq(d.repo);
    const nextId = `${key}-${String(seq).padStart(4, '0')}`;
    const hasOpenspec = existsSync(join(d.repo, 'openspec'));
    const pmPromptText = pmTicketPrompt({ n: goal.n, title: goal.title }, key, nextId, {
      notes: promptNotes,
      hasOpenspec,
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
      pmOutput = await d.runner('pm', pmAgent, pmPromptText, d.repo, pmLogFile, { signal: d.signal });
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
      d.store.setTicketState(d.repo, t.id, 'pending', pmAgent, 'PM created ticket', 0);
      tasks[t.id] = 'pending';
      const num = parseInt(t.id.split('-')[1], 10);
      if (num > maxUsed) maxUsed = num;
    }
    d.store.bumpTicketSeq(d.repo, maxUsed);

    const firstId = tickets[0].id;
    const lastId = tickets[tickets.length - 1].id;
    commitAll(d.repo, `${firstId}..${lastId}: PM tickets for G${goal.n}`, pmAuthor);

    existingGoalTickets = tickets;
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

        const devText = (devOutput.lastMessage || '') + ' ' + (devOutput.output || '');
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

        if (devText.includes('BLOCKED')) {
          d.store.endTurn(devTurnId, 'ok');
          try {
            restoreTicketFilesFromBase(d.repo, base);
            commitAll(d.repo, `${ticket.id}: blocked`, devAuthor);
          } catch {}
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
          agentId: devAgent,
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

          const deniedNote = 'command_denied: chỉ dùng lệnh trong danh sách, mỗi lệnh riêng lẻ';
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
      const qcHasSub = (d.cfg.seats_backup?.qc ?? []).some((a) => !coders.has(a));
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
      const qcPromptText = qcTicketPrompt(ticket, base, qcAgent);
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

  // 5. Goal tickets verification & Audit
  const goalTicketsAfter = loadTickets(d.repo, key, `G${goal.n}`);
  const allPassed =
    goalTicketsAfter.length > 0 &&
    goalTicketsAfter.every((t) => {
      const s = d.store.getTicketState(d.repo, t.id);
      return s?.state === 'passed';
    });

  if (!allPassed) {
    break;
  }

  let auditAgent = effectiveSeats(d.cfg, d.store, d.repo).audit || d.cfg.seats.audit;
  if (!auditAgent) {
    writeGoalSummaryAndCommit(d.repo, goal, goalTicketsAfter, d.store);
    const reviewedSha = git(d.repo, 'rev-parse', `refs/heads/${goal.branch}`).trim();
    d.store.setGoalState(d.repo, goal.n, 'qc_done', 'core', 'all tickets passed', reviewedSha);
    break;
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
  const auditHasSub = (d.cfg.seats_backup?.audit ?? []).some((a) => !goalCoders.has(a));
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
    break;
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
    const pick = await pickSeatAgent('pm', pmAgent);
    if (pick.agent === null) {
      d.store.recordHandoffFailure(sessionId, 'pm', pick.notes[0] ?? 'gate');
      return { status: 'needs_owner', sessionId, tasks, notes: pick.notes };
    }
    pmAgent = pick.agent;
    pmAuthor = authorForAgent(pmAgent);
  }
  if (isOutOfTurns(d.store, sessionId, d.cfg, 'pm')) {
    return { status: 'out_of_turns', sessionId, tasks, notes: ['Out of turns for PM'] };
  }

  const pmFixTurnId = d.store.startTurn(sessionId, 'pm', pmAgent, null);
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
    pmFixOutput = await d.runner('pm', pmAgent, pmFixPromptText, d.repo, pmFixLogFile, { signal: d.signal });
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
    d.store.setTicketState(d.repo, t.id, 'pending', pmAgent, 'PM created ticket from audit', 0);
    tasks[t.id] = 'pending';
    const num = parseInt(t.id.split('-')[1], 10);
    if (num > maxUsed) maxUsed = num;
  }
  d.store.bumpTicketSeq(d.repo, maxUsed);

  const firstId = newTickets[0].id;
  const lastId = newTickets[newTickets.length - 1].id;
  commitAll(d.repo, `${firstId}..${lastId}: PM tickets from audit for G${goal.n}`, pmAuthor);
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

export async function runSession(
  d: SessionDeps,
  goals: Array<string | { n: number }>,
  optsOrApproved?: boolean | RunSessionOpts
): Promise<SessionOutcome> {
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
