import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../src/store/db.ts';
import { loadConfig } from '../src/config.ts';
import { parsePmAnswers, pmAnswerQuestions, FINN_TAG } from '../src/core/delegate.ts';
import { pmAnswerPrompt } from '../src/core/prompts.ts';
import type { SessionDeps } from '../src/core/session.ts';
import { tmpRepo } from './helpers.ts';

function setup(runnerOut: (cwd: string) => { output?: string; lastMessage?: string; exitCode?: number }) {
  const repo = tmpRepo({ 'README.md': 'x' });
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  const sid = store.createSession(['1'], repo);
  store.setSessionStatus(sid, 'needs_owner');
  const q1 = store.addQuestion(repo, 'GT-0007', 'dev', 'jenny', 'Chạy npm test trên Windows được không?');
  const q2 = store.addQuestion(repo, 'GT-0007', 'dev', 'jenny', 'Có cần ảnh mẫu không?');
  const calls: Array<{ seat: string; prompt: string }> = [];
  const deps: SessionDeps = {
    cfg: loadConfig('btm.config.yaml'),
    store,
    repo,
    env: {},
    logDir: join(repo, '.git', 'btm-logs'),
    runner: async (seat, _agent, prompt, cwd) => {
      calls.push({ seat, prompt });
      const r = runnerOut(cwd);
      return { exitCode: r.exitCode ?? 0, timedOut: false, durationMs: 1, output: r.output ?? '', lastMessage: r.lastMessage ?? '' } as any;
    },
  };
  return { repo, store, sid, q1, q2, calls, deps };
}

describe('Để PM trả lời câu hỏi (2026-11-14)', () => {
  it('đọc khối {"answers":…} cuối trong output; rác thì null', () => {
    expect(parsePmAnswers('blah {"answers":[{"id":1,"answer":"ok","needs_owner":false}]} done')).toEqual([{ id: 1, answer: 'ok', needs_owner: false }]);
    expect(parsePmAnswers('prompt echo {"answers":[{"id":<id>}]}\n{"answers":[{"id":2,"answer":"a } b","needs_owner":true}]}')).toEqual([{ id: 2, answer: 'a } b', needs_owner: true }]);
    expect(parsePmAnswers('no json')).toBeNull();
  });

  it('prompt dặn chỉ đọc, trung thực, không nói anh Zon đã kiểm', () => {
    const p = pmAnswerPrompt([{ id: 12, ticket: 'GT-0007', seat: 'dev', text: 'Q?' }], 'elon');
    expect(p).toContain('CHỈ ĐỌC');
    expect(p).toContain('needs_owner: true');
    expect(p).toContain('Không bao giờ viết là anh Zon đã kiểm');
    expect(p).toContain('id 12 (GT-0007');
  });

  it('chạy ghế chỉ đọc, ghi câu trả lời có nhãn PM; câu needs_owner vẫn mở', async () => {
    const t = setup(() => ({ lastMessage: '' }));
    const ids = [t.q1, t.q2];
    t.deps.runner = async (seat, _a, prompt) => {
      t.calls.push({ seat, prompt });
      return { exitCode: 0, timedOut: false, durationMs: 1, output: '', lastMessage: JSON.stringify({ answers: [
        { id: ids[0], answer: 'Cần chạy trên Windows', needs_owner: true },
        { id: ids[1], answer: 'Không cần ảnh, chấm theo acceptance', needs_owner: false },
      ] }) } as any;
    };
    const r = await pmAnswerQuestions(t.deps, t.sid);
    expect(r).toEqual({ ok: true, answered: 1, left: 1 });
    expect(t.calls[0]!.seat).toBe('qc');
    expect(t.store.getQuestion(t.q2)?.answer).toBe(`${FINN_TAG} Không cần ảnh, chấm theo acceptance`);
    expect(t.store.getQuestion(t.q1)?.state).toBe('open');
    expect(t.store.listTurns(t.sid).at(-1)?.seat).toBe('pm');
  });

  it('lượt PM sửa repo → không ghi câu trả lời nào (pm_modified_repo)', async () => {
    const t = setup((cwd) => {
      writeFileSync(join(cwd, 'README.md'), 'changed');
      return { lastMessage: '{"answers":[{"id":1,"answer":"x","needs_owner":false}]}' };
    });
    const r = await pmAnswerQuestions(t.deps, t.sid);
    expect(r.error).toBe('pm_modified_repo');
    expect(t.store.listQuestions(t.repo, 'open')).toHaveLength(2);
  });

  it('output không có JSON hợp lệ → pm_answers_invalid, câu hỏi vẫn mở', async () => {
    const t = setup(() => ({ lastMessage: 'Tôi nghĩ là ổn.' }));
    const r = await pmAnswerQuestions(t.deps, t.sid);
    expect(r.error).toBe('pm_answers_invalid');
    expect(t.store.listQuestions(t.repo, 'open')).toHaveLength(2);
  });
});
