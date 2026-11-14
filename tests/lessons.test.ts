import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import {
  appendLessons, lessonsFile, lessonsForPrompt, parseLessons, readLessons, sharedLessonsFile, LESSONS_KEEP,
} from '../src/knowledge/lessons.ts';
import { createAskLane, LESSONS_TO, readAnswers } from '../src/server/ask-lane.ts';
import { pmTicketPrompt } from '../src/core/prompts.ts';
import { tmpRepo } from './helpers.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'btm-lessons-'));

describe('Bài học: parse / ghi / dán prompt (2026-11-14)', () => {
  it('parse khối JSON cuối, làm sạch, ≤10, câu có } vẫn đọc được; rác → null', () => {
    const many = Array.from({ length: 14 }, (_, i) => `bài ${i} }`);
    expect(parseLessons(`blah\n{"lessons":${JSON.stringify(many)}}`)).toHaveLength(10);
    expect(parseLessons(String.raw`{"lessons":["a\u0007b  c"]}`)).toEqual(['a b c']);
    expect(parseLessons('{"lessons":["' + 'x'.repeat(500) + '"]}')![0]).toHaveLength(300);
    expect(parseLessons('no json here')).toBeNull();
    expect(parseLessons('{"lessons":[]}')).toBeNull();
    expect(parseLessons('{"lessons": "not array"}')).toBeNull();
  });

  it('append giữ 30 dòng mới nhất, giữ dòng anh tự viết', () => {
    const f = join(tmp(), 'k', 'lessons.md');
    appendLessons(f, 'GT G1', ['đầu']);
    const text = readLessons(f).replace('- [GT G1] đầu', '# Ghi chú của anh\n- [GT G1] đầu');
    writeFileSync(f, text);
    appendLessons(f, 'GT G2', Array.from({ length: 35 }, (_, i) => `b${i}`));
    const lines = readLessons(f).split('\n').filter(Boolean);
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(LESSONS_KEEP);
    expect(lines).toContain('# Ghi chú của anh');
    expect(lines[lines.length - 1]).toBe('- [GT G2] b34');
    expect(lines).not.toContain('- [GT G1] đầu');
  });

  it('prompt: project trước, chung sau, bỏ trùng, ≤ max; chưa có file → rỗng', () => {
    const dir = tmp();
    expect(lessonsForPrompt(dir, 'GT')).toBe('');
    appendLessons(lessonsFile(dir, 'GT'), 'GT G1', ['riêng']);
    appendLessons(sharedLessonsFile(dir), 'GT G1', ['riêng']);
    appendLessons(sharedLessonsFile(dir), 'MG G2', ['chung']);
    expect(lessonsForPrompt(dir, 'GT')).toBe('- [GT G1] riêng\n- [MG G2] chung');
    expect(lessonsForPrompt(dir, 'GT', 20)).toBe('- [GT G1] riêng');
    const p = pmTicketPrompt({ n: 3, title: 'x' }, 'GT', 'GT-0009', { lessons: '- [GT G1] riêng' });
    expect(p).toContain('Bài học từ các goal trước');
    expect(pmTicketPrompt({ n: 3, title: 'x' }, 'GT', 'GT-0009', { lessons: '' })).not.toContain('Bài học');
  });
});

describe('Bài học: làn hỏi đáp (2026-11-14)', () => {
  function setup(answer: string, exitCode = 0) {
    const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n', 'README.md': 'x' });
    const store = openStore(':memory:');
    store.setActiveProject(repo);
    const base = loadConfig('btm.config.yaml');
    const agents = Object.keys(base.agents);
    const dataDir = tmp();
    const cfg = { ...base, host: { ...base.host, data_dir: dataDir }, seats: { pm: agents[0]!, dev: agents[0]!, qc: agents[0]!, audit: agents[0]! } } as Config;
    store.createGoal(repo, 'Game');
    const runner = vi.fn(async () => ({ exitCode, timedOut: false, output: '', lastMessage: answer }));
    const lane = createAskLane({ cfg, store, runner: runner as any, logDir: join(dataDir, 'logs'), isolated: true, hostBusy: () => false });
    store.enqueue(LESSONS_TO as any, 'G1');
    return { repo, store, cfg, dataDir, runner, lane, pm: agents[0]! };
  }

  it('ok → ghi 2 file, Meeting room có câu trả lời, lượt PM chỉ đọc (runner seat qc, noImport)', async () => {
    const t = setup('Xong.\n{"lessons":["Chạy npm test trước khi nộp","Scope phải là đường dẫn trần"]}');
    await t.lane.tick();
    expect(t.runner).toHaveBeenCalledTimes(1);
    const call = t.runner.mock.calls[0] as any[];
    expect(call[0]).toBe('qc');
    expect(call[1]).toBe(t.pm);
    expect(call[5]).toMatchObject({ noImport: true });
    expect(readLessons(lessonsFile(t.dataDir, 'GT'))).toContain('- [GT G1] Chạy npm test trước khi nộp');
    expect(readLessons(sharedLessonsFile(t.dataDir))).toContain('- [GT G1] Scope phải là đường dẫn trần');
    const a = readAnswers(t.store, t.repo)[0]!;
    expect(a).toMatchObject({ seat: 'pm', agent: t.pm, question: 'Bài học G1' });
    expect(t.store.nextQueuedAsk()).toBeNull();
  });

  it('output rác → không ghi file, lượt rejected; exit lỗi → error', async () => {
    const t = setup('không có JSON');
    await t.lane.tick();
    expect(existsSync(lessonsFile(t.dataDir, 'GT'))).toBe(false);
    const turns = t.store.ticketTurns(t.repo, 'LESSONS-G1');
    expect(turns[0]).toMatchObject({ result: 'rejected', error: 'lessons_invalid' });

    const u = setup('{"lessons":["x"]}', 1);
    await u.lane.tick();
    expect(u.store.ticketTurns(u.repo, 'LESSONS-G1')[0]).toMatchObject({ result: 'error' });
    expect(existsSync(lessonsFile(u.dataDir, 'GT'))).toBe(false);
  });

  it('goal không tồn tại → bỏ việc, không chạy agent', async () => {
    const t = setup('{"lessons":["x"]}');
    t.store.setQueueStatus(t.store.nextQueuedAsk()!.id, 'done');
    t.store.enqueue(LESSONS_TO as any, 'G99');
    await t.lane.tick();
    expect(t.runner).not.toHaveBeenCalled();
    expect(t.store.nextQueuedAsk()).toBeNull();
  });
});
