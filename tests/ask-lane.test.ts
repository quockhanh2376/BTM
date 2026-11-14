import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createAskLane, readAnswers } from '../src/server/ask-lane.ts';
import { buildSnapshot } from '../src/server/snapshot.ts';
import { tmpRepo } from './helpers.ts';

function setup() {
  const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n', 'README.md': 'x' });
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  const base = loadConfig('btm.config.yaml');
  const agents = Object.keys(base.agents);
  const cfg = { ...base, seats: { pm: agents[0]!, dev: agents[1] ?? agents[0]!, qc: agents[0]!, audit: agents[2] ?? agents[1] ?? agents[0]! } } as Config;
  // Phiên goal đang chạy: Dev đang có lượt mở.
  const goalSid = store.createSession(['1'], repo);
  store.setSessionStatus(goalSid, 'running');
  store.startTurn(goalSid, 'dev', cfg.seats.dev, 'GT-0001');
  const calls: Array<{ seat: string; agent: string; opts: any }> = [];
  const runner = vi.fn(async (seat: any, agent: string, _p: string, _c: string, _l: string, opts: any) => {
    calls.push({ seat, agent, opts });
    return { exitCode: 0, timedOut: false, durationMs: 1, output: '', lastMessage: 'G1 có lỗi DoS null byte, đã sửa ở GT-0007.' };
  }) as any;
  const logDir = mkdtempSync(join(tmpdir(), 'btm-ask-'));
  return { repo, store, cfg, goalSid, calls, runner, logDir };
}

describe('Bước 3: làn hỏi chạy song song (2026-11-14)', () => {
  it('cách ly: chạy khi phiên goal đang chạy, chỉ đọc, KHÔNG nhập về checkout, lưu câu trả lời', async () => {
    const t = setup();
    const lane = createAskLane({ cfg: t.cfg, store: t.store, runner: t.runner, logDir: t.logDir, isolated: true, hostBusy: () => true });
    t.store.enqueue('ask-audit' as any, 'Audit G1 gặp lỗi gì?');
    await lane.tick();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.seat).toBe('audit');
    expect(t.calls[0]!.opts.noImport).toBe(true);
    const ans = readAnswers(t.store, t.repo);
    expect(ans[0]).toMatchObject({ seat: 'audit', asked: 'audit', question: 'Audit G1 gặp lỗi gì?', answer: 'G1 có lỗi DoS null byte, đã sửa ở GT-0007.' });
    // dashboard vẫn hiện phiên goal đang chạy, không phải phiên "Ask"
    expect(buildSnapshot(t.store, t.cfg).session?.id).toBe(t.goalSid);
    expect(buildSnapshot(t.store, t.cfg).answers?.[0]?.seat).toBe('audit');
  });

  it('người được hỏi đang bận (cùng agent với lượt đang chạy) → người rảnh khác trả lời thay', async () => {
    const t = setup();
    const lane = createAskLane({ cfg: t.cfg, store: t.store, runner: t.runner, logDir: t.logDir, isolated: true, hostBusy: () => true });
    t.store.enqueue('ask-dev' as any, 'Marry làm tới đâu?');
    await lane.tick();
    expect(t.calls[0]!.agent).not.toBe(t.cfg.seats.dev);
    const a = readAnswers(t.store, t.repo)[0]!;
    expect(a.asked).toBe('dev');
    expect(a.seat).not.toBe('dev');
  });

  it('không cách ly: host bận thì không chạy song song (agent chạy thẳng trong checkout)', async () => {
    const t = setup();
    const lane = createAskLane({ cfg: t.cfg, store: t.store, runner: t.runner, logDir: t.logDir, isolated: false, hostBusy: () => true });
    t.store.enqueue('ask-audit' as any, 'q');
    await lane.tick();
    expect(t.calls).toHaveLength(0);
    expect(t.store.nextQueuedAsk()?.text).toBe('q');
    expect(t.store.nextQueued()).toBeNull(); // làn lệnh thường không nhặt câu hỏi
  });
});
