import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Seat, Tool } from '../config.ts';
import { effectiveSeats, type Store, type BoardState, type QueueItem } from '../store/db.ts';
import { loadTaskCards } from '../task/card.ts';
import type { EnergyWindow } from '../energy/quota.ts';
import type { LoginState } from '../energy/login.ts';

export interface SeatCard {
  seat: Seat;
  agent: string;
  tool: Tool;
  status: 'running' | 'waiting' | 'idle';
  taskId: string | null;
  since: string | null;
  turns: number;
  lastLine: string;
  energy: {
    status: 'fresh' | 'unknown';
    windows: EnergyWindow[];
    readAt: string;
    note?: string;
  };
  login: {
    state: LoginState;
    detail: string;
  };
  candidates: string[];
}

export interface AccountCard {
  agent: string;
  tool: Tool;
  login: {
    state: LoginState;
    detail: string;
  };
}

export interface SnapshotNote {
  id: number;
  text: string;
  image: string | null;
  status: string;
  at: string;
  report: string;
}

export interface Snapshot {
  project: string | null;
  session: {
    id: number;
    status: string;
    goals: string[];
    turnsUsed: number;
    maxTurns: number;
  } | null;
  holder: Seat | null;
  seats: SeatCard[];
  tasks: {
    id: string;
    goal: string;
    state: BoardState;
    fixRounds: number;
  }[];
  log: {
    at: string;
    who: string;
    text: string;
  }[];
  queue: QueueItem[];
  settings: {
    autoApprove: boolean;
  };
  members: string[];
  notes: SnapshotNote[];
  accounts: AccountCard[];
  sshHint?: string;
}

const ANSI_REGEX = /(?:\x1B\]|\u009D)[\s\S]*?(?:\x07|\x1B\\|\u009C)|(?:\x1B\[|\u009B)[0-?]*[ -/]*[@-~]|[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\x1B[@-Z\\-_]/g;

export function lastLogLine(file: string | null): string {
  if (!file || typeof file !== 'string') {
    return '';
  }
  try {
    if (!existsSync(file)) {
      return '';
    }
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0) {
      return '';
    }

    const CHUNK_SIZE = 64 * 1024;
    const MAX_READ = 1024 * 1024;

    const fd = openSync(file, 'r');
    try {
      let readSize = 0;
      while (readSize < stat.size && readSize < MAX_READ) {
        readSize = Math.min(readSize + CHUNK_SIZE, stat.size, MAX_READ);
        const offset = stat.size - readSize;
        const buffer = Buffer.alloc(readSize);
        readSync(fd, buffer, 0, readSize, offset);
        const content = buffer.toString('utf8');
        const cleaned = content.replace(ANSI_REGEX, '');
        const lines = cleaned.split(/\r?\n/);
        const startIndex = offset > 0 ? 1 : 0;
        for (let i = lines.length - 1; i >= startIndex; i--) {
          const trimmed = lines[i].trim();
          if (trimmed.length > 0) {
            return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
          }
        }
        if (readSize >= stat.size || readSize >= MAX_READ) {
          break;
        }
      }
      return '';
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function getSeatEnergy(store: Store, agent: string): SeatCard['energy'] {
  const r = store.latestEnergy(agent);
  if (!r) {
    return { status: 'unknown', windows: [], readAt: '' };
  }
  const res: SeatCard['energy'] = {
    status: r.status,
    windows: r.windows,
    readAt: r.readAt,
  };
  if (r.note !== undefined && r.note !== null) {
    res.note = r.note;
  }
  return res;
}

function getSeatLogin(store: Store, agent: string): SeatCard['login'] {
  const h = store.latestLogin(agent);
  if (!h) {
    return { state: 'unknown', detail: 'Chưa rõ' };
  }
  return {
    state: h.state,
    detail: h.detail,
  };
}

function getAccounts(store: Store, cfg: Config): AccountCard[] {
  return Object.keys(cfg.agents).map((agent) => {
    const tool = cfg.agents[agent].tool;
    const login = getSeatLogin(store, agent);
    return {
      agent,
      tool,
      login,
    };
  });
}

function createDefaultSeats(cfg: Config, store: Store): SeatCard[] {
  const effSeats = effectiveSeats(cfg, store);
  const seats = Object.keys(effSeats) as Seat[];
  return seats.map((seat) => {
    const agent = effSeats[seat];
    const tool = cfg.agents[agent].tool;
    const candidates = Object.entries(cfg.agents)
      .filter(([_, a]) => a.can_sit.includes(seat))
      .map(([name]) => name);
    return {
      seat,
      agent,
      tool,
      status: 'idle',
      taskId: null,
      since: null,
      turns: 0,
      lastLine: '',
      energy: getSeatEnergy(store, agent),
      login: getSeatLogin(store, agent),
      candidates,
    };
  });
}

export function buildSnapshot(store: Store, cfg: Config): Snapshot {
  const project = store.getActiveProject();
  const queue = store.listQueue(50);
  const autoApproveVal = store.getSetting('auto_approve');
  const autoApprove = autoApproveVal !== null ? autoApproveVal === 'true' : !cfg.session.require_task_approval;
  const settings = { autoApprove };
  const members = Object.keys(cfg.agents);

  const rawNotes = project ? store.listNotes(project, 10) : [];
  let allCards: ReturnType<typeof loadTaskCards> = [];
  if (project) {
    try {
      allCards = loadTaskCards(join(project, 'team', 'tasks'), project);
    } catch {}
  }

  const notes = rawNotes.map((n) => {
    let reportLines: string[] = [];
    if (project) {
      const matchingCards = allCards.filter(
        (c) => c.note === `N-${n.id}` || c.note === String(n.id)
      );
      for (const card of matchingCards) {
        const reportFile = join(project, 'team', 'reports', `${card.id}-dev.md`);
        if (existsSync(reportFile)) {
          try {
            const content = readFileSync(reportFile, 'utf8');
            const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
            reportLines.push(...lines);
          } catch {}
        }
      }
    }
    const report = reportLines.slice(0, 10).join('\n');
    return {
      id: n.id,
      text: n.text,
      image: n.image,
      status: n.status,
      at: n.created_at,
      report,
    };
  });

  const accounts = getAccounts(store, cfg);
  const sshHint = cfg.host.ssh_hint;

  if (!project) {
    return {
      project: null,
      session: null,
      holder: null,
      seats: createDefaultSeats(cfg, store),
      tasks: [],
      log: [],
      queue,
      settings,
      members,
      notes,
      accounts,
      sshHint,
    };
  }

  let latestSessionRow = store.getLatestSession(undefined, project);
  if (!latestSessionRow) {
    const anyLatest = store.getLatestSession();
    if (anyLatest && (!anyLatest.project || anyLatest.project === project)) {
      latestSessionRow = anyLatest;
    }
  }

  if (!latestSessionRow) {
    return {
      project,
      session: null,
      holder: null,
      seats: createDefaultSeats(cfg, store),
      tasks: [],
      log: [],
      queue,
      settings,
      members,
      notes,
      accounts,
      sshHint,
    };
  }

  const s = store.getSession(latestSessionRow.id);
  if (!s) {
    return {
      project,
      session: null,
      holder: null,
      seats: createDefaultSeats(cfg, store),
      tasks: [],
      log: [],
      queue,
      settings,
      members,
      notes,
      accounts,
      sshHint,
    };
  }

  const turns = store.listTurns(s.id);
  const runningTurn = turns.find((t) => t.ended_at === null);
  const holder: Seat | null = runningTurn ? runningTurn.seat : null;

  const effSeats = effectiveSeats(cfg, store);
  const seatKeys = Object.keys(effSeats) as Seat[];
  const seats: SeatCard[] = seatKeys.map((seat) => {
    const agent = effSeats[seat];
    const tool = cfg.agents[agent].tool;
    const candidates = Object.entries(cfg.agents)
      .filter(([_, a]) => a.can_sit.includes(seat))
      .map(([name]) => name);

    let status: 'running' | 'waiting' | 'idle' = 'idle';
    if (holder === seat) {
      status = 'running';
    } else if (s.status === 'running' && holder !== null) {
      status = 'waiting';
    } else {
      status = 'idle';
    }

    const seatTurns = turns.filter((t) => t.seat === seat);
    const lastTurn = seatTurns.length > 0 ? seatTurns[seatTurns.length - 1] : null;

    const taskId = lastTurn?.task_id ?? null;
    const since = lastTurn?.started_at ?? null;
    const turnsCount = store.countTurns(s.id, seat);
    const lastLine = lastLogLine(lastTurn?.log_file ?? null);

    return {
      seat,
      agent,
      tool,
      status,
      taskId,
      since,
      turns: turnsCount,
      lastLine,
      energy: getSeatEnergy(store, agent),
      login: getSeatLogin(store, agent),
      candidates,
    };
  });

  const taskStates = store.listTaskStates(s.id);
  const taskGoals = new Map<string, string>();
  try {
    const cards = loadTaskCards(join(project, 'team', 'tasks'), project);
    for (const card of cards) {
      taskGoals.set(card.id, card.goal);
    }
  } catch {}

  const tasks = taskStates.map((ts) => {
    return {
      id: ts.task_id,
      goal: taskGoals.get(ts.task_id) ?? '',
      state: ts.state,
      fixRounds: ts.fix_rounds,
    };
  });

  const logEntries: { at: string; who: string; text: string }[] = [];

  if (s.started_at) {
    logEntries.push({
      at: s.started_at,
      who: 'session',
      text: 'started',
    });
  }

  if (s.ended_at) {
    logEntries.push({
      at: s.ended_at,
      who: 'session',
      text: s.status,
    });
  }

  for (const turn of turns) {
    logEntries.push({
      at: turn.started_at,
      who: turn.agent,
      text: turn.task_id ? `bắt đầu ${turn.task_id}` : 'bắt đầu',
    });
    if (turn.ended_at) {
      logEntries.push({
        at: turn.ended_at,
        who: turn.agent,
        text: turn.error ? `${turn.result ?? 'error'}: ${turn.error}` : (turn.result ?? 'ok'),
      });
    }
  }

  const failures = store.listHandoffFailures(s.id);
  for (const f of failures) {
    logEntries.push({
      at: f.at,
      who: 'gate',
      text: f.reason,
    });
  }

  logEntries.sort((a, b) => b.at.localeCompare(a.at));
  const log = logEntries.slice(0, 50);

  return {
    project,
    session: {
      id: s.id,
      status: s.status,
      goals: s.goals,
      turnsUsed: store.countTurns(s.id),
      maxTurns: cfg.session.max_turns,
    },
    holder,
    seats,
    tasks,
    log,
    queue,
    settings,
    members,
    notes,
    accounts,
    sshHint,
  };
}
