import { join } from 'node:path';
import { z } from 'zod';
import { effectiveSeats, type QuestionRow } from '../store/db.ts';
import { git, headSha } from '../git.ts';
import { pmAnswerPrompt } from './prompts.ts';
import type { SessionDeps } from './session.ts';

// Anh Zon 2026-11-14: "Để Finn trả lời" – một lượt PM CHỈ ĐỌC trả lời các câu hỏi đang mở thay anh.
// Spec: docs/superpowers/specs/2026-11-14-pm-answers-questions-design.md

export const FINN_TAG = '(PM trả lời)';

const AnswersSchema = z.object({
  answers: z.array(z.object({
    id: z.number().int().positive(),
    answer: z.string().trim().min(1).max(2000),
    needs_owner: z.boolean(),
  }).passthrough()).max(50),
}).passthrough();

export interface DelegateResult {
  ok: boolean;
  answered: number;
  left: number;
  error?: string;
}

/** Lấy khối JSON {"answers":[…]} cuối cùng trong output của agent (output không tin cậy). */
export function parsePmAnswers(text: string): z.infer<typeof AnswersSchema>['answers'] | null {
  const s = String(text || '');
  for (let i = s.lastIndexOf('{"answers"'); i >= 0; i = s.lastIndexOf('{"answers"', i - 1)) {
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const parsed = AnswersSchema.safeParse(JSON.parse(s.slice(i, j + 1)));
          if (parsed.success) return parsed.data.answers;
        } catch { /* thử khối trước */ }
        break;
      }
    }
    if (i === 0) break;
  }
  return null;
}

function cleanAnswer(a: string): string {
  return a.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 1900);
}

export async function pmAnswerQuestions(d: SessionDeps, sessionId: number): Promise<DelegateResult> {
  const open = d.store.listQuestions(d.repo, 'open');
  if (open.length === 0) return { ok: false, answered: 0, left: 0, error: 'No open questions' };
  const agent = effectiveSeats(d.cfg, d.store, d.repo).pm;
  if (!agent) return { ok: false, answered: 0, left: open.length, error: 'No agent on the PM seat' };
  const gate = d.gate?.(agent);
  if (gate && !gate.ok) return { ok: false, answered: 0, left: open.length, error: gate.reason };

  const turnId = d.store.startTurn(sessionId, 'pm', agent, open[0]!.ticket);
  const logFile = join(d.logDir, `turn-${turnId}.log`);
  d.store.setTurnLog(turnId, logFile);
  const headBefore = headSha(d.repo);
  const treeBefore = git(d.repo, 'status', '--porcelain', '-uall');

  let out;
  try {
    // Ghế 'qc' cho runner = chạy CHỈ ĐỌC (READ_ONLY_SEATS); lượt vẫn ghi là của PM.
    out = await d.runner('qc', agent, pmAnswerPrompt(open, agent), d.repo, logFile, { signal: d.signal });
  } catch (err) {
    d.store.endTurn(turnId, 'error', err instanceof Error ? err.message : String(err));
    return { ok: false, answered: 0, left: open.length, error: 'pm_turn_failed' };
  }
  // Lượt chỉ đọc mà repo đổi → không dùng câu trả lời, anh xem lại.
  if (headSha(d.repo) !== headBefore || git(d.repo, 'status', '--porcelain', '-uall') !== treeBefore) {
    d.store.endTurn(turnId, 'rejected', 'pm_modified_repo');
    return { ok: false, answered: 0, left: open.length, error: 'pm_modified_repo' };
  }
  if (out.timedOut || out.exitCode !== 0) {
    d.store.endTurn(turnId, out.timedOut ? 'timeout' : 'error', out.timedOut ? 'timeout' : `exit_${out.exitCode}`);
    return { ok: false, answered: 0, left: open.length, error: 'pm_turn_failed' };
  }
  const answers = parsePmAnswers(`${out.output || ''}\n${out.lastMessage || ''}`);
  if (!answers) {
    d.store.endTurn(turnId, 'rejected', 'pm_answers_invalid');
    return { ok: false, answered: 0, left: open.length, error: 'pm_answers_invalid' };
  }
  const openIds = new Set(open.map((q: QuestionRow) => q.id));
  let answered = 0;
  for (const a of answers) {
    if (a.needs_owner || !openIds.has(a.id)) continue;
    d.store.answerQuestion(a.id, `${FINN_TAG} ${cleanAnswer(a.answer)}`);
    openIds.delete(a.id);
    answered++;
  }
  d.store.endTurn(turnId, 'ok');
  return { ok: true, answered, left: openIds.size };
}
