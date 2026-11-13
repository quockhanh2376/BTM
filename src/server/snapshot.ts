import { readRelease, type ReleaseInfo } from '../release/publish.ts';
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, lstatSync } from 'node:fs';
import { agentAvatarVerKey, agentNameKey } from '../agents/names.ts';
import { cleanStatus, isIsolated, readWorkerStatus, STATUS_FILE } from '../isolation/trusted.ts';
import { join } from 'node:path';
import type { Config, Effort, Seat, Tool } from '../config.ts';
import { agentEffort, agentModel } from '../agents/model.ts';
import { workerUser } from '../isolation/worker.ts';
import { readAgentModels } from '../energy/monitor.ts';
import { effectiveSeats, resolveSeats, type Store, type GoalState, type QueueItem, type AccountLabel } from '../store/db.ts';
import { accountKey, accountLastKey, pickAccount, usableAccounts } from '../agents/accounts.ts';
import { usageLimitedKey } from '../agents/usage-limit.ts';
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
  /** Decision 0006: kết quả push GitHub sau khi merge (chỉ có khi project có cấu hình release.github). */
  release?: ReleaseInfo;
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
  /** Dòng trạng thái agent đang chạy tự ghi (Plan 6 Task 7), đã làm sạch. */
  agentStatus?: string | null;
  /** Lượt xong gần nhất của ghế (anh Zon 2026-11-13): ticket · thời gian · kết quả. */
  lastRun?: { task: string | null; durationMs: number; result: string } | null;
  /** Tổng thời gian các lượt đã xong của ghế trên ticket đang/vừa làm. */
  onTask?: { task: string; totalMs: number; runs: number } | null;
}

// Kết quả lượt cho thẻ ghế: lỗi cụ thể nếu có (timeout, aborted…), cắt gọn, chỉ ký tự an toàn.
function runResult(t: { result: string | null; error: string | null }): string {
  const raw = t.error || t.result || '';
  return raw.split(':')[0]!.replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'unknown';
}

function seatTiming(seatTurns: Array<{ task_id: string | null; started_at: string; ended_at: string | null; result: string | null; error: string | null }>, runningTask: string | null): Pick<SeatCard, 'lastRun' | 'onTask'> {
  const dur = (t: { started_at: string; ended_at: string | null }) => Math.max(0, Date.parse(t.ended_at!) - Date.parse(t.started_at)) || 0;
  const done = seatTurns.filter((t) => t.ended_at);
  const last = done.length > 0 ? done[done.length - 1]! : null;
  const lastRun = last ? { task: last.task_id, durationMs: dur(last), result: runResult(last) } : null;
  const task = runningTask ?? last?.task_id ?? null;
  if (!task) return { lastRun, onTask: null };
  const mine = done.filter((t) => t.task_id === task);
  const onTask = { task, totalMs: mine.reduce((a, t) => a + dur(t), 0), runs: mine.length };
  return { lastRun, onTask };
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
  /** Plan 7: tài khoản của Worker theo thứ tự (card login/energy = tài khoản đang dùng). */
  accounts: AccountItem[];
}

export interface AccountItem {
  key: string;
  slug: string;
  email: string | null;
  label: AccountLabel;
  active: boolean;
  status: 'in_use' | 'next' | 'free' | 'limited' | 'sleeping' | 'relogin';
  resetsAt: string | null;
  user: string | null;
  login: SeatCard['login'];
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
    /** Tên hiển thị anh Zon đặt cho Worker (chỉ UI; backend vẫn dùng id agent). */
    names: Record<string, string>;
    /** Agent có avatar → phiên bản (đổi khi đổi ảnh, để trình duyệt tải lại /api/avatar/<agent>?v=). */
    avatars: Record<string, string>;
  };
  members: string[];
  notes: SnapshotNote[];
  accounts: AccountCard[];
  /** Đổi ghế bị bỏ qua (agent lạ, không được ngồi ghế, YAML lỗi). */
  seatWarnings: string[];
  /** Plan 6 Task 4: câu hỏi chặn ticket đang chờ anh trả lời (project active). */
  questions: Array<{ id: number; ticket: string; seat: string; agent: string | null; text: string }>;
  sshHint?: string;
  /** Plan 9: phiên bản BTM (package.json) cho sidebar. */
  version?: string;
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

// Plan 6 Task 7: đọc dòng trạng thái của agent đang chạy, cache 15 giây (đọc qua worker là lệnh đồng bộ).
const statusCache = new Map<string, { at: number; text: string }>();
function readAgentStatus(cfg: Config, agent: string, project: string): string | null {
  const key = `${agent}|${project}`;
  const hit = statusCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.text || null;
  let text = '';
  try {
    if (isIsolated(cfg)) {
      text = readWorkerStatus(cfg, agent, project);
    } else {
      const f = join(project, STATUS_FILE);
      const st = lstatSync(f);
      if (st.isFile() && st.size <= 64_000) text = cleanStatus(readFileSync(f, 'utf8').slice(0, 1000));
    }
  } catch {
    text = '';
  }
  statusCache.set(key, { at: Date.now(), text });
  return text || null;
}

function openQuestions(store: Store): Snapshot['questions'] {
  const project = store.getActiveProject();
  if (!project) return [];
  return store.listQuestions(project, 'open').map((q) => ({ id: q.id, ticket: q.ticket, seat: q.seat, agent: q.agent, text: q.text }));
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
function userOf(cfg: Config, key: string): string | null {
  try {
    return workerUser(cfg, key);
  } catch {
    return null;
  }
}

// Plan 7: trạng thái từng tài khoản. in_use = tài khoản lượt kế sẽ dùng; next = tài khoản dùng được kế tiếp.
function accountItems(store: Store, cfg: Config, agent: string, now: Date): AccountItem[] {
  const rows = store.listAccounts(agent);
  const list = rows.length ? rows : [{ agent, slug: 'default', email: null, label: 'none' as AccountLabel, active: true, ord: 0, created_at: '' }];
  const usable = usableAccounts(cfg, store, agent, now).map((a) => a.key);
  return list.map((a): AccountItem => {
    const key = accountKey(agent, a.slug);
    const login = getSeatLogin(store, key);
    const until = store.getSetting(usageLimitedKey(key));
    const limited = !!until && Date.parse(until) > now.getTime();
    const status: AccountItem['status'] = !a.active
      ? 'sleeping'
      : login.state === 'relogin'
        ? 'relogin'
        : limited
          ? 'limited'
          : usable[0] === key
            ? 'in_use'
            : usable[1] === key
              ? 'next'
              : 'free';
    return { key, slug: a.slug, email: a.email, label: a.label, active: a.active, status, resetsAt: limited ? until : null, user: userOf(cfg, key), login, energy: getSeatEnergy(store, key, cfg) };
  });
}

function getAccounts(store: Store, cfg: Config): AccountCard[] {
  const rank = (a: AccountCard) => a.energy.minPercent ?? 101;
  const now = new Date();
  return Object.keys(cfg.agents).map((agent): AccountCard => {
    const tool = cfg.agents[agent].tool;
    const accounts = accountItems(store, cfg, agent, now);
    const current = accounts.find((a) => a.status === 'in_use')?.key ?? agent;
    return {
      agent,
      tool,
      login: getSeatLogin(store, current),
      model: agentModel(cfg, store, agent) ?? null,
      effort: agentEffort(cfg, store, agent),
      user: userOf(cfg, current),
      modelOptions: readAgentModels(store, agent)?.models ?? [],
      energy: getSeatEnergy(store, current, cfg),
      accounts,
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
      energy: getSeatEnergy(store, pickAccount(cfg, store, agent)?.key || agent, cfg),
      login: getSeatLogin(store, pickAccount(cfg, store, agent)?.key || agent),
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

      const release = readRelease(store, project, g.n);
      goals.push({
        n: g.n,
        title: g.title,
        state: g.state,
        stage,
        passed,
        total,
        tickets: combinedTickets,
        ...(release ? { release } : {}),
      });
    }

    return goals;
  } catch {
    return [];
  }
}

// Plan 9: phiên bản hiện ở sidebar; đọc một lần lúc nạp module.
const BTM_VERSION: string = (() => {
  try {
    const v = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : '';
  } catch {
    return '';
  }
})();

export function buildSnapshot(store: Store, cfg: Config): Snapshot {
  const project = store.getActiveProject();
  const queue = store.listQueue(50);
  const autoApproveVal = store.getSetting('auto_approve');
  const autoApprove = autoApproveVal !== null ? autoApproveVal === 'true' : !cfg.session.require_task_approval;
  const members = Object.keys(cfg.agents);
  const names: Record<string, string> = {};
  const avatars: Record<string, string> = {};
  for (const a of members) {
    const n = store.getSetting(agentNameKey(a));
    if (n) names[a] = n;
    const v = store.getSetting(agentAvatarVerKey(a));
    if (v) avatars[a] = v;
  }
  const settings = { autoApprove, names, avatars };

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
      questions: openQuestions(store),
      sshHint,
      version: BTM_VERSION,
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
      questions: openQuestions(store),
      sshHint,
      version: BTM_VERSION,
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
      questions: openQuestions(store),
      sshHint,
      version: BTM_VERSION,
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

    // Plan 7: đang chạy → tài khoản lượt này; rảnh → tài khoản lượt kế sẽ dùng.
    const seatAccount = (status === 'running' ? store.getSetting(accountLastKey(agent)) : pickAccount(cfg, store, agent)?.key) || agent;
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
      energy: getSeatEnergy(store, seatAccount, cfg),
      login: getSeatLogin(store, seatAccount),
      candidates,
      ...seatExtras(cfg, store, effSeats, seat, agent),
      substitute: lastTurn?.agent && lastTurn.agent !== agent ? lastTurn.agent : null,
      agentStatus: status === 'running' && s.project && runningTurn?.agent ? readAgentStatus(cfg, store.getSetting(accountLastKey(runningTurn.agent)) || runningTurn.agent, s.project) : null,
      ...seatTiming(seatTurns, ticket),
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
    questions: openQuestions(store),
    sshHint,
    version: BTM_VERSION,
  };
}
