// Làn họp (anh Zon 2026-11-14): chạy từng lượt của cuộc họp, lần lượt, chỉ đọc, song song với phiên goal.
// Spec: docs/superpowers/specs/2026-11-14-debate-meeting-design.md
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { effectiveSeats, type Store } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { usableAccounts } from '../agents/accounts.ts';
import { agentNameKey } from '../agents/names.ts';
import { mbStatus } from '../mb/vault.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { buildProjectMap } from '../knowledge/map.ts';
import { skillsFor } from '../skills/lane.ts';
import { fetchGithubMaterial } from './github.ts';
import { extractDoc, joinDocs, materialForPrompt, DOCS_MAX, type DocText, type PdfToText } from './docs.ts';
import {
  conclusionPrompt, decisionsFile, materialFile, meetingFile, meetingPrompt, nextStep, parseConclusion, parsePoints, parseVote, renderMeetingMd, speakersOf,
  verifyEvidence, voteOptions, votePrompt, votersOf, voteTally, MEETING_KEEP, TOPIC_MAX, type Meeting, type MeetingTurn, type Speaker,
} from './core.ts';

export const meetingsKey = (project: string) => `meetings:${project}`;
/** Anh Zon 2026-11-14: "dọn phòng họp" – mốc thời gian; tin cũ hơn mốc bị ẩn khỏi Meeting room (dữ liệu vẫn giữ). */
export const roomClearedKey = (project: string) => `room_cleared_at:${project}`;
export const stagedDocsKey = (project: string) => `meeting_docs:${project}`;
/** Tài liệu đang chờ (đã rút chữ) cho cuộc họp sắp mở. */
export interface StagedDoc { id: number; name: string; note: string; chars: number }

export function readStagedDocs(store: Pick<Store, 'getSetting'>, project: string): StagedDoc[] {
  try {
    const v = JSON.parse(store.getSetting(stagedDocsKey(project)) || '[]');
    return Array.isArray(v) ? (v as StagedDoc[]) : [];
  } catch {
    return [];
  }
}

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
  /** Test thay pdftotext bằng hàm giả. */
  pdf?: PdfToText;
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
  const stagedFile = (project: string, id: number) => join(dataDir, 'knowledge', readProjectKey(project), 'meetings', 'staging', `${id}.txt`);

  /** Anh upload một file: Core rút chữ ngay, giữ ở khu chờ tới khi mở cuộc họp. */
  async function addDoc(name: string, buf: Buffer): Promise<{ ok: true; doc: StagedDoc } | { ok: false; status: number; error: string }> {
    const project = d.store.getActiveProject();
    if (!project) return { ok: false, status: 400, error: 'No active project' };
    const staged = readStagedDocs(d.store, project);
    if (staged.length >= DOCS_MAX) return { ok: false, status: 400, error: `At most ${DOCS_MAX} documents per meeting` };
    let doc: DocText;
    try { doc = await extractDoc(name, buf, d.pdf); } catch (err) { return { ok: false, status: 400, error: err instanceof Error ? err.message : 'Could not read this file' }; }
    const id = staged.reduce((mx, s) => Math.max(mx, s.id), 0) + 1;
    try {
      const f = stagedFile(project, id);
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      writeFileSync(f, doc.text, { mode: 0o600 });
    } catch {
      return { ok: false, status: 500, error: 'Could not store this file' };
    }
    const meta: StagedDoc = { id, name: doc.name, note: doc.note, chars: doc.text.length };
    d.store.setSetting(stagedDocsKey(project), JSON.stringify([...staged, meta]));
    return { ok: true, doc: meta };
  }
  function removeDoc(id: number): StagedDoc[] {
    const project = d.store.getActiveProject();
    if (!project) return [];
    const left = readStagedDocs(d.store, project).filter((s) => s.id !== id);
    d.store.setSetting(stagedDocsKey(project), JSON.stringify(left));
    try { rmSync(stagedFile(project, id), { force: true }); } catch { /* đã xoá */ }
    return left;
  }
  function listDocs(): StagedDoc[] {
    const project = d.store.getActiveProject();
    return project ? readStagedDocs(d.store, project) : [];
  }
  /** Chuyển tài liệu đang chờ vào cuộc họp: gộp toàn văn vào file tài liệu, dọn khu chờ. */
  function takeStagedDocs(project: string, id: number): Array<{ name: string; note: string }> {
    const staged = readStagedDocs(d.store, project);
    if (!staged.length) return [];
    const docs: DocText[] = [];
    for (const s of staged) {
      try { docs.push({ name: s.name, note: s.note, text: readFileSync(stagedFile(project, s.id), 'utf8') }); } catch { /* mất file: bỏ qua */ }
      try { rmSync(stagedFile(project, s.id), { force: true }); } catch { /* bỏ qua */ }
    }
    d.store.setSetting(stagedDocsKey(project), '[]');
    if (!docs.length) return [];
    try {
      const f = materialFile(dataDir, readProjectKey(project), id);
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      writeFileSync(f, joinDocs(docs), { mode: 0o600 });
    } catch {
      return [];
    }
    return docs.map((x) => ({ name: x.name, note: x.note }));
  }

  const active = (project: string) => readMeetings(d.store, project).find((m) => m.status === 'running' || m.status === 'paused') ?? null;

  /** BTM khởi động lại giữa cuộc họp: cuộc đang chạy chuyển sang tạm dừng, anh bấm Resume. */
  function recover(): void {
    const project = d.store.getActiveProject();
    if (!project) return;
    for (const m of readMeetings(d.store, project)) if (m.status === 'running') save(project, { ...m, status: 'paused' });
  }

  async function start(topicRaw: string, quick: boolean, optionsRaw?: string[]): Promise<Result> {
    const project = d.store.getActiveProject();
    if (!project) return { ok: false, status: 400, error: 'No active project' };
    const topic = String(topicRaw || '').trim().slice(0, TOPIC_MAX);
    if (!topic) return { ok: false, status: 400, error: 'Empty topic' };
    if (active(project)) return { ok: false, status: 409, error: 'A meeting is already open' };
    const st = mbStatus(d.store);
    // Biểu quyết (anh Zon 2026-11-14): có 2–5 phương án → mỗi ghế một phiếu.
    const options = optionsRaw ? voteOptions(optionsRaw) : [];
    if (optionsRaw && options.length < 2) return { ok: false, status: 400, error: 'A vote needs 2 to 5 different options' };
    const seatsNow = effectiveSeats(d.cfg, d.store, project) as Record<string, string>;
    const speakers = options.length ? votersOf(d.cfg, seatsNow, st.set && st.enabled) : speakersOf(d.cfg, seatsNow, st.set && st.enabled);
    if (!speakers.length) return { ok: false, status: 400, error: 'No agents on any seat' };
    const id = readMeetings(d.store, project).reduce((mx, m) => Math.max(mx, m.id), 0) + 1;
    const docs = takeStagedDocs(project, id);
    const m: Meeting = { id, topic, quick: options.length ? true : quick, status: 'running', createdAt: new Date().toISOString(), speakers, turns: [], ownerNotes: [], ...(docs.length ? { docs } : {}), ...(options.length ? { vote: { options } } : {}) };
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
              // Tài liệu GitHub đứng trước file anh upload (nếu có).
              const have = material(project, cur);
              writeFileSync(f, have ? `## FILE: GitHub ${got.source}\n${got.text}\n\n${have}` : got.text, { mode: 0o600 });
            } catch { /* không lưu được: họp không có tài liệu GitHub */ }
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

  /** Anh chốt phương án của cuộc biểu quyết (có thể khác đa số). Ghi sổ quyết định của project – PM đọc khi lập kế hoạch. */
  function decide(option: string): Result {
    const project = d.store.getActiveProject();
    if (!project) return { ok: false, status: 400, error: 'No active project' };
    const m = readMeetings(d.store, project).find((x) => x.vote && x.status !== 'running');
    if (!m || !m.vote) return { ok: false, status: 400, error: 'No finished vote' };
    const picked = m.vote.options.find((o) => o === option);
    if (!picked) return { ok: false, status: 400, error: 'Unknown option' };
    const tally = voteTally(m);
    const decided: Meeting = { ...m, status: m.status === 'paused' ? 'closed' : m.status, endedAt: m.endedAt ?? new Date().toISOString(), decision: { option: picked, at: new Date().toISOString(), overrode: tally.winner !== null && tally.winner !== picked } };
    save(project, decided);
    saveMd(project, decided);
    try {
      const key = readProjectKey(project);
      const file = decisionsFile(dataDir, key);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      let prev = '';
      try { prev = readFileSync(file, 'utf8'); } catch { /* chưa có sổ */ }
      const lines = prev.split(/\r?\n/).filter((l) => l.startsWith('- ')).filter((l) => !l.startsWith(`- [${key} M${m.id}] `));
      lines.push(`- [${key} M${m.id}] ${m.topic.replace(/\s+/g, ' ').slice(0, 200)} → ${picked}${decided.decision!.overrode ? ' (anh Zon phủ quyết đa số)' : ''}`);
      writeFileSync(file, lines.slice(-50).join('\n') + '\n', { mode: 0o600 });
    } catch { /* ghi sổ lỗi không làm hỏng việc chốt */ }
    return { ok: true, id: m.id };
  }

  /** Xoá hẳn (anh Zon 2026-11-14, họp nháp lúc dev BTM): cuộc họp đã kết thúc tạo trước `before`, kèm biên bản + tài liệu. */
  function purgeBefore(before: string): number {
    const project = d.store.getActiveProject();
    if (!project) return 0;
    const all = readMeetings(d.store, project);
    const t = Date.parse(before);
    const gone = all.filter((m) => m.status !== 'running' && m.status !== 'paused' && Date.parse(m.createdAt) < t);
    if (!gone.length) return 0;
    d.store.setSetting(meetingsKey(project), JSON.stringify(all.filter((m) => !gone.includes(m))));
    try {
      const key = readProjectKey(project);
      for (const m of gone) for (const f of [meetingFile(dataDir, key, m.id), materialFile(dataDir, key, m.id)]) rmSync(f, { force: true });
    } catch { /* thiếu file: bỏ qua */ }
    d.onChange?.();
    return gone.length;
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
        // Skill anh bật cho ghế của người nói (ghế đầu tiên; Boss không có ghế → không có skill).
        const seatOf = (['pm', 'dev', 'qc', 'audit'] as const).find((s) => speaker.seats.includes(s));
        const skills = seatOf ? skillsFor(d.store, dataDir, project, seatOf) : '';
        if (m.vote) {
          const vctx = { material: materialForPrompt(material(project, m), m.topic), knowledge: buildProjectMap(d.store, project, 2500), name: nameOf(speaker.agent) };
          const vres = await runAgent(project, m, speaker, votePrompt(m, speaker, vctx) + (skills ? `\n\n${skills}` : ''), `V-${speaker.seats[0]}`);
          if (vres.aborted) return;
          const v = vres.text ? parseVote(vres.text, m.vote.options) : null;
          if (!v) { skip(vres.reason ?? 'invalid vote'); return; }
          const vc = {
            repo: project,
            material: material(project, m),
            hasTicket: (id: string) => d.store.listTickets(project).some((t) => t.id === id),
            hasGoal: (n: number) => Boolean(d.store.getGoal(project, n)),
          };
          const ev = v.evidence ?? { type: 'general' as const, ref: '' };
          const vt: MeetingTurn = { round: 1, agent: speaker.agent, seats: speaker.seats, at: now(), vote: v.vote, points: [{ text: v.reason, evidence: ev, verified: v.evidence ? verifyEvidence(ev, vc) : null }] };
          const curV = fresh();
          if (curV && curV.status === 'running') save(project, { ...curV, turns: [...curV.turns, vt] });
          return;
        }
        const prompt = meetingPrompt(m, speaker, round, { material: materialForPrompt(material(project, m), m.topic), knowledge: buildProjectMap(d.store, project, 2500), name: nameOf(speaker.agent) }) + (skills ? `\n\n${skills}` : '');
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
  return { start, stop, resume, close, decide, purgeBefore, tick, addDoc, removeDoc, listDocs, running: () => inFlight };
}
