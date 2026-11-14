// Làn họp (anh Zon 2026-11-14): chạy từng lượt của cuộc họp, lần lượt, chỉ đọc, song song với phiên goal.
// Spec: docs/superpowers/specs/2026-11-14-debate-meeting-design.md
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { effectiveSeats, type Store } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { usableAccounts } from '../agents/accounts.ts';
import { agentNameKey } from '../agents/names.ts';
import { mbStatus } from '../mb/vault.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { buildProjectMap } from '../knowledge/map.ts';
import { fetchGithubMaterial } from './github.ts';
import {
  conclusionPrompt, materialFile, meetingFile, meetingPrompt, nextStep, parseConclusion, parsePoints, renderMeetingMd, speakersOf,
  verifyEvidence, MEETING_KEEP, TOPIC_MAX, type Meeting, type MeetingTurn, type Speaker,
} from './core.ts';

export const meetingsKey = (project: string) => `meetings:${project}`;

export function readMeetings(store: Pick<Store, 'getSetting'>, project: string): Meeting[] {
  try {
    const v = JSON.parse(store.getSetting(meetingsKey(project)) || '[]');
    return Array.isArray(v) ? (v as Meeting[]) : [];
  } catch {
    return [];
  }
}

/** Cuộc họp cho dashboard: cuộc đang mở, không có thì cuộc gần nhất. */
export function latestMeeting(store: Pick<Store, 'getSetting'>, project: string): Meeting | null {
  const all = readMeetings(store, project);
  return all.find((m) => m.status === 'running' || m.status === 'paused') ?? all[0] ?? null;
}

export interface MeetingLaneDeps {
  cfg: Config;
  store: Store;
  runner: Runner;
  logDir: string;
  isolated: boolean;
  hostBusy: () => boolean;
  gate?: (agent: string) => { ok: true } | { ok: false; reason: string };
  fetchFn?: typeof fetch;
  onChange?: () => void;
}

type Result = { ok: true; id: number } | { ok: false; status: number; error: string };

export function createMeetingLane(d: MeetingLaneDeps) {
  let inFlight = false;
  let abort: AbortController | null = null;

  const nameOf = (agent: string) => d.store.getSetting(agentNameKey(agent)) || agent;
  const dataDir = d.cfg.host.data_dir;

  function save(project: string, m: Meeting): void {
    const all = readMeetings(d.store, project).filter((x) => x.id !== m.id);
    all.unshift(m);
    all.sort((a, b) => b.id - a.id);
    d.store.setSetting(meetingsKey(project), JSON.stringify(all.slice(0, MEETING_KEEP)));
    d.onChange?.();
  }
  function saveMd(project: string, m: Meeting): void {
    try {
      const file = meetingFile(dataDir, readProjectKey(project), m.id);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, renderMeetingMd(m, nameOf), { mode: 0o600 });
    } catch { /* lưu biên bản lỗi không làm hỏng cuộc họp */ }
  }
  function material(project: string, m: Meeting): string {
    try { return readFileSync(materialFile(dataDir, readProjectKey(project), m.id), 'utf8'); } catch { return ''; }
  }
  const active = (project: string) => readMeetings(d.store, project).find((m) => m.status === 'running' || m.status === 'paused') ?? null;

  /** BTM khởi động lại giữa cuộc họp: cuộc đang chạy chuyển sang tạm dừng, anh bấm Resume. */
  function recover(): void {
    const project = d.store.getActiveProject();
    if (!project) return;
    for (const m of readMeetings(d.store, project)) if (m.status === 'running') save(project, { ...m, status: 'paused' });
  }

  async function start(topicRaw: string, quick: boolean): Promise<Result> {
    const project = d.store.getActiveProject();
    if (!project) return { ok: false, status: 400, error: 'No active project' };
    const topic = String(topicRaw || '').trim().slice(0, TOPIC_MAX);
    if (!topic) return { ok: false, status: 400, error: 'Empty topic' };
    if (active(project)) return { ok: false, status: 409, error: 'A meeting is already open' };
    const st = mbStatus(d.store);
    const speakers = speakersOf(d.cfg, effectiveSeats(d.cfg, d.store, project) as Record<string, string>, st.set && st.enabled);
    if (!speakers.length) return { ok: false, status: 400, error: 'No agents on any seat' };
    const id = readMeetings(d.store, project).reduce((mx, m) => Math.max(mx, m.id), 0) + 1;
    const m: Meeting = { id, topic, quick, status: 'running', createdAt: new Date().toISOString(), speakers, turns: [], ownerNotes: [] };
    save(project, m);
    void (async () => {
      // Link repo GitHub công khai trong vấn đề → Core tải tài liệu (agent không có mạng).
      const got = await fetchGithubMaterial(topic, d.fetchFn).catch(() => null);
      if (got) {
        const cur = readMeetings(d.store, project).find((x) => x.id === id);
        if (cur) {
          if (got.text) {
            try {
              const f = materialFile(dataDir, readProjectKey(project), id);
              mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
              writeFileSync(f, got.text, { mode: 0o600 });
            } catch { /* không lưu được: họp không có tài liệu */ }
          }
          save(project, { ...cur, source: got.source, materialNote: got.note });
        }
      }
      void tick();
    })();
    return { ok: true, id };
  }

  function stop(): Result {
    const project = d.store.getActiveProject();
    const m = project ? active(project) : null;
    if (!project || !m) return { ok: false, status: 400, error: 'No open meeting' };
    save(project, { ...m, status: 'paused' });
    abort?.abort();
    saveMd(project, { ...m, status: 'paused' });
    return { ok: true, id: m.id };
  }

  function resume(note?: string, concludeNow = false): Result {
    const project = d.store.getActiveProject();
    const m = project ? active(project) : null;
    if (!project || !m) return { ok: false, status: 400, error: 'No open meeting' };
    const text = String(note || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
    const next: Meeting = { ...m, status: 'running', ownerNotes: text ? [...m.ownerNotes, { at: new Date().toISOString(), text }] : m.ownerNotes };
    if (concludeNow) {
      // Kết luận luôn: các lượt chưa nói được ghi "bỏ qua" để bước kế tiếp là kết luận.
      for (const round of (next.quick ? [1] : [1, 2]) as Array<1 | 2>) {
        for (const s of next.speakers) {
          if (!next.turns.some((t) => t.round === round && t.agent === s.agent)) {
            next.turns = [...next.turns, { round, agent: s.agent, seats: s.seats, at: new Date().toISOString(), points: [], skipped: 'concluded early' }];
          }
        }
      }
    }
    save(project, next);
    void tick();
    return { ok: true, id: m.id };
  }

  function close(): Result {
    const project = d.store.getActiveProject();
    const m = project ? active(project) : null;
    if (!project || !m) return { ok: false, status: 400, error: 'No open meeting' };
    const closed: Meeting = { ...m, status: 'closed', endedAt: new Date().toISOString() };
    save(project, closed);
    abort?.abort();
    saveMd(project, closed);
    return { ok: true, id: m.id };
  }

  /** Người kết luận: PM trước, rồi những người còn lại, Boss cuối; bỏ người đang bận / bị chặn. */
  function pickConcluder(m: Meeting, busy: Set<string>): Speaker | null {
    const order = [...m.speakers].sort((a, b) => Number(b.seats.includes('pm')) - Number(a.seats.includes('pm')) || Number(a.seats.includes('boss')) - Number(b.seats.includes('boss')));
    return order.find((s) => !busy.has(s.agent) && (d.gate?.(s.agent).ok ?? true)) ?? null;
  }

  async function runAgent(project: string, m: Meeting, speaker: Speaker, prompt: string, label: string): Promise<{ text: string | null; reason?: string; aborted?: boolean }> {
    const seat = (['pm', 'dev', 'qc', 'audit'].includes(speaker.seats[0]!) ? speaker.seats[0] : 'pm') as Seat;
    const sid = d.store.createSession(['Meeting'], project);
    d.store.setSessionStatus(sid, 'running');
    const turnId = d.store.startTurn(sid, seat, speaker.agent, `MEET-${m.id}-${label}`);
    abort = new AbortController();
    const signal = abort.signal;
    let ok = false;
    try {
      mkdirSync(d.logDir, { recursive: true });
      const logFile = join(d.logDir, `turn-${turnId}.log`);
      d.store.setTurnLog(turnId, logFile);
      const out = await d.runner('qc', speaker.agent, prompt, project, logFile, {
        account: usableAccounts(d.cfg, d.store, speaker.agent)[0]?.key,
        noImport: true,
        signal,
      });
      if (signal.aborted) {
        d.store.endTurn(turnId, 'error', 'meeting_stopped');
        return { text: null, aborted: true };
      }
      ok = !out.timedOut && out.exitCode === 0;
      d.store.endTurn(turnId, ok ? 'ok' : out.timedOut ? 'timeout' : 'error', ok ? undefined : out.timedOut ? 'timeout' : `exit_${out.exitCode}`);
      return ok ? { text: `${out.output || ''}\n${out.lastMessage || ''}` } : { text: null, reason: out.timedOut ? 'timeout' : `error exit_${out.exitCode}` };
    } catch (err) {
      d.store.endTurn(turnId, 'error', signal.aborted ? 'meeting_stopped' : err instanceof Error ? err.message : String(err));
      return signal.aborted ? { text: null, aborted: true } : { text: null, reason: 'error' };
    } finally {
      d.store.setSessionStatus(sid, ok ? 'done' : 'error');
      abort = null;
    }
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    const project = d.store.getActiveProject();
    if (!project) return;
    if (!d.isolated && d.hostBusy()) return;
    const m = readMeetings(d.store, project).find((x) => x.status === 'running');
    if (!m) return;
    const step = nextStep(m);
    if (!step) {
      const done: Meeting = { ...m, status: 'done', endedAt: new Date().toISOString() };
      save(project, done);
      saveMd(project, done);
      return;
    }
    const busy = new Set(d.store.openTurnAgents());
    const now = () => new Date().toISOString();
    // Trạng thái mới nhất của cuộc họp (anh có thể Stop / Close trong lúc lượt đang chạy).
    const fresh = () => readMeetings(d.store, project).find((x) => x.id === m.id);

    if (step.kind === 'turn') {
      const { speaker, round } = step;
      if (busy.has(speaker.agent)) return; // đang làm việc khác: chờ lần tick sau
      const gate = d.gate?.(speaker.agent);
      const skip = (reason: string) => {
        const cur = fresh();
        if (cur && cur.status === 'running') save(project, { ...cur, turns: [...cur.turns, { round, agent: speaker.agent, seats: speaker.seats, at: now(), points: [], skipped: reason }] });
      };
      if (gate && !gate.ok) { skip(gate.reason); return void tick(); }
      inFlight = true;
      try {
        const prompt = meetingPrompt(m, speaker, round, { material: material(project, m), knowledge: buildProjectMap(d.store, project, 2500), name: nameOf(speaker.agent) });
        const res = await runAgent(project, m, speaker, prompt, `R${round}`);
        if (res.aborted) return; // Stop / Close: không ghi lượt, Resume sẽ chạy lại người này
        const points = res.text ? parsePoints(res.text) : null;
        if (!points) { skip(res.reason ?? 'invalid answer'); return; }
        const ctx = {
          repo: project,
          material: material(project, m),
          hasTicket: (id: string) => d.store.listTickets(project).some((t) => t.id === id),
          hasGoal: (n: number) => Boolean(d.store.getGoal(project, n)),
        };
        const turn: MeetingTurn = { round, agent: speaker.agent, seats: speaker.seats, at: now(), points: points.map((p) => ({ ...p, verified: verifyEvidence(p.evidence, ctx) })) };
        if (!turn.points.length) turn.skipped = 'no point with evidence';
        const cur = fresh();
        if (cur && cur.status === 'running') save(project, { ...cur, turns: [...cur.turns, turn] });
      } finally {
        inFlight = false;
        void tick();
      }
      return;
    }

    // Kết luận
    const who = pickConcluder(m, busy);
    if (!who) {
      if (m.speakers.every((s) => !(d.gate?.(s.agent).ok ?? true))) {
        const done: Meeting = { ...m, conclusionSkipped: 'no agent available', status: 'done', endedAt: now() };
        save(project, done);
        saveMd(project, done);
      }
      return; // có người chỉ đang bận: chờ
    }
    inFlight = true;
    try {
      const res = await runAgent(project, m, who, conclusionPrompt(m, nameOf(who.agent)), 'END');
      if (res.aborted) return;
      const c = res.text ? parseConclusion(res.text) : null;
      const cur = fresh();
      if (!cur || cur.status !== 'running') return;
      const done: Meeting = c
        ? { ...cur, conclusion: { ...c, by: who.agent, at: now() }, status: 'done', endedAt: now() }
        : { ...cur, conclusionSkipped: res.reason ?? 'invalid answer', status: 'done', endedAt: now() };
      save(project, done);
      saveMd(project, done);
    } finally {
      inFlight = false;
    }
  }

  recover();
  return { start, stop, resume, close, tick, running: () => inFlight };
}
