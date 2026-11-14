// Biểu quyết + xoá hẳn họp nháp (anh Zon 2026-11-14).
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { decisionsFile, meetingFile, nextStep, parseVote, renderMeetingMd, voteOptions, votersOf, voteTally, type Meeting } from '../src/meeting/core.ts';
import { decisionsForPrompt } from '../src/meeting/decisions.ts';
import { createMeetingLane, latestMeeting, readMeetings } from '../src/meeting/lane.ts';
import { pmTicketPrompt } from '../src/core/prompts.ts';
import { purgeAnswersBefore, readAnswers, saveAnswer } from '../src/server/ask-lane.ts';
import { readWeb, tmpRepo } from './helpers.ts';

const cfgAgents = { elon: {}, jenny: {}, bruno: {}, mb: { provider: 'zai' } } as any;
const seats = { pm: 'elon', dev: 'jenny', qc: 'elon', audit: 'bruno' };

describe('Biểu quyết – phần thuần', () => {
  it('mỗi ghế một phiếu: PM, Dev, QC, Audit + Boss = 5 (Finn bỏ 2 phiếu); không có Boss → 4', () => {
    expect(votersOf({ agents: cfgAgents }, seats, true).map((s) => `${s.agent}:${s.seats[0]}`)).toEqual(['elon:pm', 'jenny:dev', 'elon:qc', 'bruno:audit', 'mb:boss']);
    expect(votersOf({ agents: cfgAgents }, seats, false)).toHaveLength(4);
  });

  it('phương án: tách dấu phẩy / chấm phẩy / xuống dòng, bỏ trùng (không dấu, không hoa thường), tối đa 5', () => {
    expect(voteOptions('Dark, Light')).toEqual(['Dark', 'Light']);
    expect(voteOptions('Sáng; sang ; Tối\nTỐI')).toEqual(['Sáng', 'Tối']);
    expect(voteOptions('a,b,c,d,e,f,g')).toHaveLength(5);
    expect(voteOptions(['  Dark ', 'dark', 'Light'])).toEqual(['Dark', 'Light']);
  });

  it('đọc phiếu: phải khớp một phương án (không phân biệt hoa thường / dấu); rác hoặc phương án lạ → null', () => {
    expect(parseVote('Lý do…\n{"vote":"dark","reason":"Dễ nhìn ban đêm","evidence":{"type":"general","ref":"WCAG 2.1"}}', ['Dark', 'Light']))
      .toEqual({ vote: 'Dark', reason: 'Dễ nhìn ban đêm', evidence: { type: 'general', ref: 'WCAG 2.1' } });
    expect(parseVote('{"vote":"Tối"}', ['Sáng', 'toi'])!.vote).toBe('toi');
    expect(parseVote('{"vote":"Blue"}', ['Dark', 'Light'])).toBeNull();
    expect(parseVote('không có json', ['Dark', 'Light'])).toBeNull();
  });

  it('đếm phiếu: thứ tự phương án, phiếu bị bỏ qua không tính, hoà → không có đa số; biên bản ghi kết quả + quyết định', () => {
    const t = (seat: string, vote: string, skipped?: string) => ({ round: 1 as const, agent: 'x', seats: [seat], at: 't', points: [{ text: 'vì', evidence: { type: 'general' as const, ref: '' }, verified: null }], vote, ...(skipped ? { skipped } : {}) });
    const m: Meeting = { id: 3, topic: 'UI v1 mặc định?', quick: true, status: 'done', createdAt: 't', speakers: [], ownerNotes: [], vote: { options: ['Dark', 'Light'] },
      turns: [t('pm', 'Dark'), t('dev', 'Light'), t('qc', 'Dark'), t('audit', 'Light', 'timeout'), t('boss', 'Dark')] };
    expect(voteTally(m)).toEqual({ counts: [{ option: 'Dark', n: 3, seats: ['pm', 'qc', 'boss'] }, { option: 'Light', n: 1, seats: ['dev'] }], total: 4, winner: 'Dark' });
    expect(voteTally({ ...m, turns: [t('pm', 'Dark'), t('dev', 'Light')] }).winner).toBeNull();
    const md = renderMeetingMd({ ...m, decision: { option: 'Light', at: 'T', overrode: true } });
    expect(md).toContain('## Biểu quyết: Dark / Light');
    expect(md).toContain('**Kết quả:** Dark 3 · Light 1 (4 phiếu) → đa số: Dark');
    expect(md).toContain('**Anh Zon chốt:** Light (phủ quyết đa số)');
    expect(nextStep({ ...m, status: 'running', speakers: [{ agent: 'elon', seats: ['pm'] }, { agent: 'elon', seats: ['qc'] }], turns: [t('pm', 'Dark')] })).toMatchObject({ kind: 'turn', speaker: { seats: ['qc'] } });
    expect(nextStep({ ...m, status: 'running', speakers: [{ agent: 'elon', seats: ['pm'] }], turns: [t('pm', 'Dark')] })).toBeNull();
  });
});

describe('Biểu quyết – làn họp', () => {
  function setup(answer: (agent: string, prompt: string) => string) {
    const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n' });
    const store = openStore(':memory:');
    store.setActiveProject(repo);
    const base = loadConfig('btm.config.yaml');
    const dataDir = mkdtempSync(join(tmpdir(), 'btm-vote-'));
    const cfg = { ...base, host: { ...base.host, data_dir: dataDir }, seats: { pm: 'elon', dev: 'jenny', qc: 'elon', audit: 'jenny' } } as Config;
    const runner = vi.fn(async (_s: string, agent: string, prompt: string) => ({ exitCode: 0, timedOut: false, output: '', lastMessage: answer(agent, prompt) }));
    const lane = createMeetingLane({ cfg, store, runner: runner as any, logDir: join(dataDir, 'logs'), isolated: true, hostBusy: () => false, fetchFn: (async () => ({ ok: false, text: async () => '' })) as any });
    const settle = async () => { for (let i = 0; i < 80 && readMeetings(store, repo).some((m) => m.status === 'running'); i++) await new Promise((r) => setTimeout(r, 15)); };
    return { repo, store, dataDir, runner, lane, settle };
  }

  it('mỗi ghế một lượt, bỏ phiếu độc lập (không thấy phiếu người khác), không có lượt kết luận; anh chốt (cả phủ quyết) → sổ quyết định → PM đọc', async () => {
    const t = setup((_a, p) => (p.includes('ghế PM') || p.includes('ghế QC') ? '{"vote":"Dark","reason":"dễ nhìn"}' : '{"vote":"Light","reason":"in ấn"}'));
    expect(await t.lane.start('UI v1 mặc định dark hay light?', false, ['Dark', 'Light', 'dark'])).toMatchObject({ ok: true, id: 1 });
    await t.settle();
    const m = latestMeeting(t.store, t.repo)!;
    expect(m.status).toBe('done');
    expect(m.turns.map((x) => `${x.seats[0]}:${x.vote}`)).toEqual(['pm:Dark', 'dev:Light', 'qc:Dark', 'audit:Light']);
    expect(t.runner).toHaveBeenCalledTimes(4);
    for (const c of t.runner.mock.calls as any[]) { expect(c[0]).toBe('qc'); expect(c[5]).toMatchObject({ noImport: true }); }
    expect((t.runner.mock.calls[3] as any[])[2]).not.toContain('Dark", "reason');
    expect(m.conclusion).toBeUndefined();
    expect(voteTally(m).winner).toBeNull(); // 2–2 vì test không bật Boss
    expect(t.lane.decide('Blue')).toMatchObject({ ok: false, status: 400 });
    expect(t.lane.decide('Light')).toMatchObject({ ok: true });
    expect(latestMeeting(t.store, t.repo)!.decision).toMatchObject({ option: 'Light', overrode: false });
    const book = readFileSync(decisionsFile(t.dataDir, 'GT'), 'utf8');
    expect(book).toContain('- [GT M1] UI v1 mặc định dark hay light? → Light');
    t.lane.decide('Dark'); // đổi ý: sổ chỉ giữ dòng mới nhất của M1
    expect(readFileSync(decisionsFile(t.dataDir, 'GT'), 'utf8').match(/\[GT M1\]/g)).toHaveLength(1);
    const forPm = decisionsForPrompt(t.dataDir, 'GT');
    expect(forPm).toContain('→ Dark');
    expect(pmTicketPrompt({ n: 2, title: 'UI' }, 'GT', 'GT-0009', { decisions: forPm })).toContain('Quyết định anh Zon đã chốt');
    expect(readFileSync(meetingFile(t.dataDir, 'GT', 1), 'utf8')).toContain('**Anh Zon chốt:** Dark');
  });

  it('phiếu không hợp lệ → bỏ qua ghế đó; ít hơn 2 phương án → 400; chốt khi đa số khác → ghi phủ quyết', async () => {
    const t = setup((_a, p) => (p.includes('ghế DEV') ? 'không biết' : '{"vote":"Light","reason":"r"}'));
    expect(await t.lane.start('x', false, ['Dark'])).toMatchObject({ ok: false, status: 400 });
    await t.lane.start('UI?', false, ['Dark', 'Light']);
    await t.settle();
    const m = latestMeeting(t.store, t.repo)!;
    expect(m.turns.find((x) => x.seats[0] === 'dev')).toMatchObject({ skipped: 'invalid vote' });
    expect(voteTally(m).winner).toBe('Light');
    t.lane.decide('Dark');
    expect(latestMeeting(t.store, t.repo)!.decision).toMatchObject({ option: 'Dark', overrode: true });
  });
});

describe('Xoá hẳn họp nháp', () => {
  it('xoá cuộc họp đã kết thúc trước mốc (kèm biên bản), giữ cuộc sau mốc; câu trả lời trước mốc bị xoá', async () => {
    const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n' });
    const store = openStore(':memory:');
    store.setActiveProject(repo);
    const base = loadConfig('btm.config.yaml');
    const dataDir = mkdtempSync(join(tmpdir(), 'btm-purge-'));
    const cfg = { ...base, host: { ...base.host, data_dir: dataDir } } as Config;
    const lane = createMeetingLane({ cfg, store, runner: (async () => ({ exitCode: 0, timedOut: false, output: '', lastMessage: '' })) as any, logDir: join(dataDir, 'logs'), isolated: true, hostBusy: () => true });
    const mk = (id: number, createdAt: string, status: Meeting['status']): Meeting => ({ id, topic: `M${id}`, quick: true, status, createdAt, speakers: [], turns: [], ownerNotes: [] });
    store.setSetting(`meetings:${repo}`, JSON.stringify([mk(3, '2026-11-14T05:00:00Z', 'done'), mk(2, '2026-11-14T01:00:00Z', 'paused'), mk(1, '2026-11-14T01:00:00Z', 'closed')]));
    lane.close(); // M2 đang tạm dừng → đóng rồi xoá được? Không: close đóng M2 ngay bây giờ (createdAt vẫn trước mốc) → được xoá
    expect(existsSync(meetingFile(dataDir, 'GT', 2))).toBe(true);
    expect(lane.purgeBefore('2026-11-14T03:00:00Z')).toBe(2);
    expect(readMeetings(store, repo).map((m) => m.id)).toEqual([3]);
    expect(existsSync(meetingFile(dataDir, 'GT', 2))).toBe(false);
    saveAnswer(store, repo, { id: 9, seat: 'pm', asked: 'pm', agent: 'elon', question: 'q' }, { lastMessage: 'a' });
    expect(purgeAnswersBefore(store, repo, '2000-01-01T00:00:00Z')).toBe(0);
    expect(purgeAnswersBefore(store, repo, '2999-01-01T00:00:00Z')).toBe(1);
    expect(readAnswers(store, repo)).toEqual([]);
    const sid = store.enqueue('ask-pm' as any, 'cũ');
    store.setQueueStatus(sid, 'done');
    const live = store.enqueue('ask-pm' as any, 'đang chờ');
    expect(store.purgeQueueBefore('2999-01-01T00:00:00Z')).toBe(1);
    expect(store.listQueue(10).map((q) => q.id)).toEqual([live]);
  });

  it('giao diện: nút Xoá hẳn hỏi lại (không hoàn tác); lựa chọn Vote + ô phương án; nút chốt từng phương án', () => {
    const html = readWeb();
    expect(html).toContain("postJson('/api/meeting-room', { action: 'purge' })");
    expect(html).toContain("tone: 'danger' }))) return;");
    expect(html).toContain("{ value: 'vote', label: tx('cmd.vote') }");
    expect(html).toContain('id="vote-options"');
    expect(html).toContain("postJson('/api/meeting', { action: 'start', topic: text, options: opts })");
    expect(html).toContain("act('decide', { option: o })");
    const lib = new Function(html.slice(html.indexOf('function meetVoteTally'), html.indexOf('function meetEvidenceMark')) + 'return { meetVoteTally };')() as any;
    expect(lib.meetVoteTally({ vote: { options: ['Dark', 'Light'] }, turns: [{ seats: ['pm'], vote: 'Dark' }, { seats: ['qc'], vote: 'Dark' }, { seats: ['dev'], vote: 'Light' }] }).winner).toBe('Dark');
  });
});

describe('Nhận câu tranh luận: "Chủ đề:" và "A hay B?" (anh Zon 2026-11-14)', () => {
  it('ví dụ của anh Zon là tranh luận; câu lệnh / câu hỏi thường không đổi', () => {
    const html = readWeb();
    const lib = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return { classifyMessage };')() as any;
    const k = (s: string) => lib.classifyMessage(s, {}).kind;
    expect(k(`Chủ đề: "Cà phê muối / Trà sữa 'full topping' mỗi ngày: Là tự thưởng chữa lành hay 'tự hủy' ví tiền và sức khỏe?"`)).toBe('debate');
    expect(k(`"Cà phê muối mỗi ngày: là tự thưởng chữa lành hay tự hủy ví tiền?"`)).toBe('debate');
    expect(k('Topic: remote work vs office')).toBe('debate');
    expect(k('Tabs or spaces?')).toBe('debate');
    expect(k('G1 làm tới đâu rồi?')).toBe('ask');
    expect(k('thêm nút xoá vào trang chủ')).toBe('goal');
    expect(k('sửa lỗi hay bị treo khi tải trang')).toBe('goal');
  });
});
