import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Seat } from '../config.ts';
import { effectiveSeats, type Store } from '../store/db.ts';
import type { Runner } from '../runner/run.ts';
import { askPrompt, lessonsPrompt } from '../core/prompts.ts';
import { buildGoalDigest, knowledgeFor } from '../knowledge/digest.ts';
import { appendLessons, lessonsFile, parseLessons, readLessons, sharedLessonsFile } from '../knowledge/lessons.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { skillsFor } from '../skills/lane.ts';
import { usableAccounts } from '../agents/accounts.ts';

// Bước 3 (anh Zon 2026-11-14): câu hỏi / bàn kế hoạch chạy SONG SONG với phiên đang chạy.
// - Chỉ đọc, KHÔNG nhập workspace về checkout (noImport) → không đụng code chưa commit của lượt đang chạy.
// - Không dùng agent đang có lượt chạy (cùng worker/workspace); người được hỏi bận thì người rảnh trả lời thay.
// - Không cách ly (máy dev): chỉ chạy khi host rảnh, vì agent chạy thẳng trong checkout.

export interface AskAnswer {
  id: number;
  at: string;
  seat: Seat;
  asked: Seat;
  agent: string;
  question: string;
  answer: string;
}

export const answersKey = (project: string) => `ask_answers:${project}`;
const ORDER: Seat[] = ['pm', 'qc', 'audit', 'dev'];
/** Việc "viết bài học" sau khi goal được duyệt (text = G<n>). */
export const LESSONS_TO = 'ask-lessons';
const MAX_KEEP = 20;

export function readAnswers(store: Store, project: string): AskAnswer[] {
  try { return JSON.parse(store.getSetting(answersKey(project)) || '[]') as AskAnswer[]; } catch { return []; }
}

/** Lưu câu trả lời (mới nhất trước, giữ MAX_KEEP) – dùng cho làn hỏi và lệnh trực tiếp chỉ đọc / QC. */
export function saveAnswer(store: Store, project: string, a: Omit<AskAnswer, 'answer' | 'at'>, out: { lastMessage?: string; output?: string }): void {
  const list = readAnswers(store, project).filter((x) => x.id !== a.id);
  list.unshift({ ...a, at: new Date().toISOString(), question: a.question.slice(0, 300), answer: cleanAnswer(out) });
  store.setSetting(answersKey(project), JSON.stringify(list.slice(0, MAX_KEEP)));
}

function cleanAnswer(out: { lastMessage?: string; output?: string }): string {
  const raw = (out.lastMessage || '').trim() || String(out.output || '').trim().split(/\r?\n/).slice(-15).join('\n');
  return raw
    .split(/\r?\n/)
    // Dòng chẩn đoán của Claude Code (vd model GLM của Boss: "[claude-code:unrecognized_model] {…}") không phải câu trả lời.
    .filter((l) => !/^\[claude-code:[a-z_]+\]/.test(l.trim()) && !l.trim().startsWith("Claude Code doesn't recognize the model "))
    .join('\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 2000);
}

export function createAskLane(d: {
  cfg: Config;
  store: Store;
  runner: Runner;
  logDir: string;
  isolated: boolean;
  hostBusy: () => boolean;
  onDone?: () => void;
}) {
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    const project = d.store.getActiveProject();
    if (!project) return;
    if (!d.isolated && d.hostBusy()) return;
    const item = d.store.nextQueuedAsk();
    if (!item) return;
    if (String(item.to) === LESSONS_TO) return runLessons(project, item);
    const asked = String(item.to).slice(4) as Seat;
    const seats = effectiveSeats(d.cfg, d.store) as Record<string, string>;
    const busy = new Set(d.store.openTurnAgents());
    const seat = [asked, ...ORDER.filter((s) => s !== asked)].find((s) => seats[s] && !busy.has(seats[s]!));
    if (!seat) return; // ai cũng bận: chờ lần tick sau
    const agent = seats[seat]!;

    running = true;
    d.store.setQueueStatus(item.id, 'running');
    const sid = d.store.createSession(['Ask'], project);
    d.store.setSessionStatus(sid, 'running');
    const turnId = d.store.startTurn(sid, seat, agent, `ASK-${item.id}`);
    let ok = false;
    try {
      mkdirSync(d.logDir, { recursive: true });
      const logFile = join(d.logDir, `turn-${turnId}.log`);
      d.store.setTurnLog(turnId, logFile);
      const onBehalf = seat !== asked ? `\n(${asked.toUpperCase()} đang bận, bạn trả lời thay.)` : '';
      const skills = skillsFor(d.store, d.cfg.host.data_dir, project, seat, turnId);
      const prompt = askPrompt(seat, item.text, knowledgeFor(d.store, d.cfg, project, item.text)) + onBehalf + (skills ? `\n\n${skills}` : '');
      const out = await d.runner(seat === 'audit' ? 'audit' : 'qc', agent, prompt, project, logFile, {
        account: usableAccounts(d.cfg, d.store, agent)[0]?.key,
        noImport: true,
      });
      ok = !out.timedOut && out.exitCode === 0;
      d.store.endTurn(turnId, ok ? 'ok' : (out.timedOut ? 'timeout' : 'error'), ok ? undefined : (out.timedOut ? 'timeout' : `exit_${out.exitCode}`));
      if (ok) {
        saveAnswer(d.store, project, { id: item.id, seat, asked, agent, question: item.text }, out);
      }
    } catch (err) {
      d.store.endTurn(turnId, 'error', err instanceof Error ? err.message : String(err));
    } finally {
      d.store.setSessionStatus(sid, ok ? 'done' : 'error');
      d.store.setQueueStatus(item.id, 'done');
      running = false;
      d.onDone?.();
      void tick();
    }
  }

  // Bài học (anh Zon 2026-11-14): ghế PM (Finn) viết; bận thì ghế khác; cuối cùng Boss (agent provider zai).
  async function runLessons(project: string, item: { id: number; text: string }): Promise<void> {
    const n = parseInt(String(item.text).replace(/^G/i, ''), 10);
    const digest = Number.isFinite(n) ? buildGoalDigest(d.store, d.cfg, project, n) : null;
    if (!digest) { d.store.setQueueStatus(item.id, 'done'); return; }
    const seats = effectiveSeats(d.cfg, d.store) as Record<string, string>;
    const busy = new Set(d.store.openTurnAgents());
    const boss = Object.entries(d.cfg.agents).filter(([, a]) => a.provider === 'zai').map(([id]) => id);
    const agent = [...ORDER.map((s) => seats[s]), ...boss].find((a): a is string => Boolean(a) && !busy.has(a!));
    if (!agent) return; // ai cũng bận: chờ lần tick sau

    running = true;
    d.store.setQueueStatus(item.id, 'running');
    const sid = d.store.createSession(['Lessons'], project);
    d.store.setSessionStatus(sid, 'running');
    const turnId = d.store.startTurn(sid, 'pm', agent, `LESSONS-G${n}`);
    let ok = false;
    try {
      mkdirSync(d.logDir, { recursive: true });
      const logFile = join(d.logDir, `turn-${turnId}.log`);
      d.store.setTurnLog(turnId, logFile);
      const key = readProjectKey(project);
      const own = lessonsFile(d.cfg.host.data_dir, key);
      const out = await d.runner('qc', agent, lessonsPrompt(n, digest, readLessons(own).slice(-3000)), project, logFile, {
        account: usableAccounts(d.cfg, d.store, agent)[0]?.key,
        noImport: true,
      });
      const lessons = !out.timedOut && out.exitCode === 0 ? parseLessons(`${out.output || ''}\n${out.lastMessage || ''}`) : null;
      if (lessons) {
        appendLessons(own, `${key} G${n}`, lessons);
        appendLessons(sharedLessonsFile(d.cfg.host.data_dir), `${key} G${n}`, lessons);
        saveAnswer(d.store, project, { id: item.id, seat: 'pm', asked: 'pm', agent, question: `Bài học G${n}` },
          { lastMessage: lessons.map((l) => `- ${l}`).join('\n') });
        ok = true;
      }
      d.store.endTurn(turnId, ok ? 'ok' : out.timedOut ? 'timeout' : out.exitCode !== 0 ? 'error' : 'rejected',
        ok ? undefined : out.timedOut ? 'timeout' : out.exitCode !== 0 ? `exit_${out.exitCode}` : 'lessons_invalid');
    } catch (err) {
      d.store.endTurn(turnId, 'error', err instanceof Error ? err.message : String(err));
    } finally {
      d.store.setSessionStatus(sid, ok ? 'done' : 'error');
      d.store.setQueueStatus(item.id, 'done');
      running = false;
      d.onDone?.();
      void tick();
    }
  }

  return { tick, running: () => running };
}
