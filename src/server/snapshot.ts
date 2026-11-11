import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Effort, Seat, Tool } from '../config.ts';
import { agentEffort, agentModel } from '../agents/model.ts';
import { workerUser } from '../isolation/worker.ts';
import { readAgentModels } from '../energy/monitor.ts';
import { effectiveSeats, resolveSeats, type Store, type GoalState, type QueueItem } from '../store/db.ts';
import { loadTickets, type Ticket, type TicketState, type TicketType, type TicketSize } from '../ticket/ticket.ts';
import { readProjectKey } from '../ticket/goal.ts';
import type { EnergyWindow } from '../energy/quota.ts';
import type { LoginState } from '../energy/login.ts';

export type GoalStage = 'intake' | 'plan' | 'build' | 'verify' | 'audit' | 'release';

export interface GoalTicketSnapshot {
  id: string;
  number: number;
  of: number;
  title: string;
  type: TicketType;
  size: TicketSize;
  state: TicketState;
  fix_rounds: number;
}

export interface GoalSnapshot {
  n: number;
  title: string;
  state: GoalState;
  stage: GoalStage;
  passed: number;
  total: number;
  tickets: GoalTicketSnapshot[];
}

export interface SeatCard {
  seat: Seat;
  agent: string;
  tool: Tool;
  status: 'running' | 'waiting' | 'idle';
  ticket: string | null;
  taskId?: string | null;
  since: string | null;
  turns: number;
  lastLine: string;
  energy: {
    status: 'fresh' | 'unknown';
    windows: EnergyWindow[];
    readAt: string;
    note?: string;
    /** Cửa sổ thấp nhất ≤ energy.warn_percent (Plan 6 Task 5). */
    warn?: boolean;
    /** Giờ hồi của cửa sổ thấp nhất. */
    soonestReset?: string | null;
    /** % còn của cửa sổ thấp nhất (để xếp tài khoản). */
    minPercent?: number | null;
  };
  login: {
    state: LoginState;
    detail: string;
  };
  candidates: string[];
  /** Model đang dùng (null = mặc định của CLI). */
  model?: string | null;
  /** Ghế khác agent này đang kiêm cùng lúc. */
  also?: Seat[];
  /** Lượt gần nhất của ghế do agent dự phòng ngồi thay (Plan 5 Task 7). */
  substitute?: string | null;
}

export interface AccountCard {
  agent: string;
  tool: Tool;
  login: {
    state: LoginState;
    detail: string;
  };
  model: string | null;
  effort: Effort;
  /** User Linux của agent khi bật cách ly (btm-<id>), null khi không. */
  user: string | null;
  /** Model CLI liệt kê được (đọc định kỳ dưới user của agent); rỗng khi chưa đọc. */
  modelOptions: string[];
  energy: SeatCard['energy'];
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
  goals: GoalSnapshot[];
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
  /** Đổi ghế bị bỏ qua (agent lạ, không được ngồi ghế, YAML lỗi). */
  seatWarnings: string[];
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

function getSeatEnergy(store: Store, agent: string, cfg?: Config): SeatCard['energy'] {
  const r = store.latestEnergy(agent);
  if (!r) {
    return { status: 'unknown', windows: [], readAt: '' };
  }
  const res: SeatCard['energy'] = {
    status: r.status,
    windows: r.windows,
    readAt: r.readAt,
  };
  if (r.status === 'fresh' && r.windows.length > 0) {
    const min = r.windows.reduce((a, w) => (w.remainingPercent < a.remainingPercent ? w : a));
    res.minPercent = min.remainingPercent;
    res.soonestReset = min.resetsAt || null;
    res.warn = min.remainingPercent <= (cfg?.energy.warn_percent ?? 20);
  }
  if (r.note !== undefined && r.note !== null) {
    res.note = r.note;
  }
  return res;
}

function getSeatLogin(store: Store, agent: string): SeatCard['login'] {
  const h = store.latestLogin(agent);
  if (!h) {
    return { state: 'unknown', detail: 'Unknown' };
  }
  return {
    state: h.state,
    detail: h.detail,
  };
}

// Giới hạn chặt nhất trước; chưa đọc được Energy xếp cuối (Plan 6 Task 5).
function getAccounts(store: Store, cfg: Config): AccountCard[] {
  const rank = (a: AccountCard) => a.energy.minPercent ?? 101;
  return Object.keys(cfg.agents).map((agent): AccountCard => {
    const tool = cfg.agents[agent].tool;
    const login = getSeatLogin(store, agent);
    let user: string | null = null;
    try {
      user = workerUser(cfg, agent);
    } catch {
      user = null;
    }
    return {
      agent,
      tool,
      login,
      model: agentModel(cfg, store, agent) ?? null,
      effort: agentEffort(cfg, store, agent),
      user,
      modelOptions: readAgentModels(store, agent)?.models ?? [],
      energy: getSeatEnergy(store, agent, cfg),
    };
  }).sort((a, b) => rank(a) - rank(b));
}

// Ghế audit hiện khi có người ngồi hoặc có agent được phép ngồi (để đổi ghế trên dashboard).
function seatKeysFor(cfg: Config, effSeats: Record<Seat, string>): Seat[] {
  const keys: Seat[] = ['pm', 'dev', 'qc'];
  const auditAgent = (effSeats.audit || cfg.seats.audit || '').trim();
  if (auditAgent || Object.values(cfg.agents).some((a) => a.can_sit.includes('audit'))) keys.push('audit');
  return keys;
}

function seatExtras(cfg: Config, store: Store, effSeats: Record<Seat, string>, seat: Seat, agent: string) {
  const also = (['pm', 'dev', 'qc', 'audit'] as Seat[]).filter((s) => s !== seat && agent && effSeats[s] === agent);
  return { model: agent ? agentModel(cfg, store, agent) ?? null : null, also };
}

function createDefaultSeats(cfg: Config, store: Store): SeatCard[] {
  const effSeats = effectiveSeats(cfg, store);
  const seatKeys = seatKeysFor(cfg, effSeats);
  return seatKeys.map((seat) => {
    const agent = effSeats[seat] || cfg.seats[seat] || '';
    const tool = cfg.agents[agent]?.tool ?? 'claude-code';
    const candidates = Object.entries(cfg.agents)
      .filter(([_, a]) => a.can_sit.includes(seat))
      .map(([name]) => name);
    return {
      seat,
      agent,
      tool,
      status: 'idle',
      ticket: null,
      taskId: null,
      since: null,
      turns: 0,
      lastLine: '',
      energy: getSeatEnergy(store, agent, cfg),
      login: getSeatLogin(store, agent),
      candidates,
      ...seatExtras(cfg, store, effSeats, seat, agent),
    };
  });
}

function buildGoals(
  project: string | null,
  store: Store,
  cfg: Config,
  holder: Seat | null
): GoalSnapshot[] {
  if (!project) return [];

  let diskTickets: Ticket[] = [];
  try {
    const key = readProjectKey(project);
    try {
      diskTickets = loadTickets(project, key);
    } catch {}
  } catch {
    // If readProjectKey throws (e.g. team/project.yaml missing in working tree),
    // proceed without disk tickets and build goals from the SQLite store
  }

  const diskTicketMap = new Map<string, Ticket>();
  for (const dt of diskTickets) {
    diskTicketMap.set(dt.id, dt);
  }

  try {
    const auditAgent = (effectiveSeats(cfg, store).audit || cfg.seats?.audit || '').trim();
    const hasAudit = auditAgent.length > 0;

    const goalRows = store.listGoals(project);
    const goals: GoalSnapshot[] = [];

    for (const g of goalRows) {
      const dbTickets = store.listTickets(project, `G${g.n}`);
      const goalDiskTickets = diskTickets.filter((dt) => dt.goal === `G${g.n}`);

      const ticketIdSet = new Set<string>();
      for (const t of dbTickets) ticketIdSet.add(t.id);
      for (const t of goalDiskTickets) ticketIdSet.add(t.id);

      const combinedTickets: GoalTicketSnapshot[] = [];
      for (const id of ticketIdSet) {
        const disk = diskTicketMap.get(id);
        const db = dbTickets.find((t) => t.id === id);
        const stateInfo = store.getTicketState(project, id);

        const number = disk?.number ?? db?.number ?? 1;
        const of = disk?.of ?? db?.of ?? 1;
        const title = disk?.title ?? db?.title ?? '';
        const type = disk?.type ?? db?.type ?? 'feat';
        const size = disk?.size ?? db?.size ?? 'S';
        const state = stateInfo?.state ?? db?.state ?? 'pending';
        const fix_rounds = stateInfo?.fix_rounds ?? db?.fix_rounds ?? 0;

        combinedTickets.push({
          id,
          number,
          of,
          title,
          type,
          size,
          state,
          fix_rounds,
        });
      }

      combinedTickets.sort((a, b) => a.number - b.number);

      const total = combinedTickets.length;
      const passed = combinedTickets.filter((t) => t.state === 'passed').length;

      let stage: GoalStage;
      if (g.state === 'open') {
        stage = 'intake';
      } else if (g.state === 'in_progress') {
        if (holder === 'pm' || combinedTickets.length === 0) {
          stage = 'plan';
        } else if (combinedTickets.some((t) => t.state === 'in_dev' || t.state === 'returned')) {
          stage = 'build';
        } else if (combinedTickets.some((t) => t.state === 'awaiting_qc')) {
          stage = 'verify';
        } else {
          stage = 'build';
        }
      } else if (g.state === 'qc_done') {
        stage = hasAudit ? 'audit' : 'release';
      } else {
        stage = 'release';
      }

      goals.push({
        n: g.n,
        title: g.title,
        state: g.state,
        stage,
        passed,
        total,
        tickets: combinedTickets,
      });
    }

    return goals;
  } catch {
    return [];
  }
}

export function buildSnapshot(store: Store, cfg: Config): Snapshot {
  const project = store.getActiveProject();
  const queue = store.listQueue(50);
  const autoApproveVal = store.getSetting('auto_approve');
  const autoApprove = autoApproveVal !== null ? autoApproveVal === 'true' : !cfg.session.require_task_approval;
  const settings = { autoApprove };
  const members = Object.keys(cfg.agents);

  const rawNotes = project ? store.listNotes(project, 10) : [];
  let allTickets: Ticket[] = [];
  if (project) {
    try {
      const key = readProjectKey(project);
      allTickets = loadTickets(project, key);
    } catch {}
  }

  const notes = rawNotes.map((n) => {
    let reportLines: string[] = [];
    if (project) {
      const matchingTickets = allTickets.filter(
        (c) => c.note === `N-${n.id}` || c.note === String(n.id)
      );
      for (const card of matchingTickets) {
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
      goals: [],
      log: [],
      queue,
      settings,
      members,
      notes,
      accounts,
      seatWarnings: resolveSeats(cfg, store).warnings,
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
      goals: buildGoals(project, store, cfg, null),
      log: [],
      queue,
      settings,
      members,
      notes,
      accounts,
      seatWarnings: resolveSeats(cfg, store).warnings,
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
      goals: buildGoals(project, store, cfg, null),
      log: [],
      queue,
      settings,
      members,
      notes,
      accounts,
      seatWarnings: resolveSeats(cfg, store).warnings,
      sshHint,
    };
  }

  const turns = store.listTurns(s.id);
  const runningTurn = turns.find((t) => t.ended_at === null);
  const holder: Seat | null = runningTurn ? runningTurn.seat : null;

  const effSeats = effectiveSeats(cfg, store);
  const seatKeys = seatKeysFor(cfg, effSeats);
  const seats: SeatCard[] = seatKeys.map((seat) => {
    const agent = effSeats[seat] || cfg.seats[seat] || '';
    const tool = cfg.agents[agent]?.tool ?? 'claude-code';
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

    const ticket = (status === 'running' && runningTurn?.seat === seat) ? (runningTurn.task_id ?? null) : null;
    const since = lastTurn?.started_at ?? null;
    const turnsCount = store.countTurns(s.id, seat);
    const lastLine = lastLogLine(lastTurn?.log_file ?? null);

    return {
      seat,
      agent,
      tool,
      status,
      ticket,
      taskId: ticket,
      since,
      turns: turnsCount,
      lastLine,
      energy: getSeatEnergy(store, agent, cfg),
      login: getSeatLogin(store, agent),
      candidates,
      ...seatExtras(cfg, store, effSeats, seat, agent),
      substitute: lastTurn?.agent && lastTurn.agent !== agent ? lastTurn.agent : null,
    };
  });

  const goals = buildGoals(project, store, cfg, holder);

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
      text: turn.task_id ? `started ${turn.task_id}` : 'started',
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
    goals,
    log,
    queue,
    settings,
    members,
    notes,
    accounts,
    seatWarnings: resolveSeats(cfg, store).warnings,
    sshHint,
  };
}
