import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { buildGoalDigest, knowledgeFor, saveGoalDigest, DIGEST_MAX } from '../src/knowledge/digest.ts';
import { askPrompt } from '../src/core/prompts.ts';
import { tmpRepo } from './helpers.ts';

function setup() {
  const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n', 'README.md': 'x' });
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  const base = loadConfig('btm.config.yaml');
  const cfg = { ...base, host: { ...base.host, data_dir: mkdtempSync(join(tmpdir(), 'btm-kb-')) } } as Config;
  store.createGoal(repo, 'Game bắn máy bay');
  store.createGoal(repo, 'Boss và âm thanh');
  const t = { goal: 'G1', of: 2, type: 'feat', size: 'S', scope: ['server.js'], acceptance: ['x'], done_when: 'x' } as any;
  store.upsertTicket(repo, { ...t, id: 'GT-0001', number: 1, title: 'Server Node' });
  store.upsertTicket(repo, { ...t, id: 'GT-0007', number: 2, title: 'Sửa lỗi DoS null byte', type: 'security' });
  store.setTicketState(repo, 'GT-0007', 'returned', 'jenny', 'gate bad_report', 1);
  store.setTicketState(repo, 'GT-0007', 'passed', 'elon', 'qc pass', 1);
  const q = store.addQuestion(repo, 'GT-0007', 'dev', 'jenny', 'Chạy npm test trên Windows được không?');
  store.answerQuestion(q, 'Đã chạy 54/54 pass');
  return { repo, store, cfg };
}

describe('Kho kiến thức: nhật ký goal nén (2026-11-14)', () => {
  it('có tiêu đề, ticket + lý do trả về, hỏi–đáp với anh, giờ VN; không quá DIGEST_MAX', () => {
    const t = setup();
    const d = buildGoalDigest(t.store, t.cfg, t.repo, 1)!;
    expect(d).toContain('# G1 · Game bắn máy bay');
    expect(d).toContain('GT-0007 #2/2 Sửa lỗi DoS null byte → passed, sửa 1 vòng; trả về vì: gate bad_report');
    expect(d).toContain('hỏi: Chạy npm test trên Windows được không? → đáp: Đã chạy 54/54 pass');
    expect(d).toContain('(giờ VN)');
    expect(d.length).toBeLessThanOrEqual(DIGEST_MAX);
    expect(buildGoalDigest(t.store, t.cfg, t.repo, 99)).toBeNull();
  });

  it('câu hỏi nhắc G1 → chỉ lấy G1; không nhắc → 2 goal mới nhất', () => {
    const t = setup();
    const k1 = knowledgeFor(t.store, t.cfg, t.repo, 'Audit G1 gặp lỗi gì?');
    expect(k1).toContain('# G1 ·');
    expect(k1).not.toContain('# G2 ·');
    const k2 = knowledgeFor(t.store, t.cfg, t.repo, 'Kế tiếp làm gì?');
    expect(k2.indexOf('# G2 ·')).toBeLessThan(k2.indexOf('# G1 ·'));
  });

  it('lưu ra <data_dir>/knowledge/<KEY>/G<n>.md; prompt hỏi kèm kho kiến thức', () => {
    const t = setup();
    const f = saveGoalDigest(t.store, t.cfg, t.repo, 1)!;
    expect(f).toBe(join(t.cfg.host.data_dir, 'knowledge', 'GT', 'G1.md'));
    expect(existsSync(f) && readFileSync(f, 'utf8')).toContain('GT-0007');
    const p = askPrompt('audit', 'G1 lỗi gì?', 'KB-TEXT');
    expect(p).toContain('Kho kiến thức team');
    expect(p).toContain('KB-TEXT');
    expect(askPrompt('audit', 'q')).not.toContain('Kho kiến thức team');
  });
});
