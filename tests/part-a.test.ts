// Đợt "phần A" (anh Zon 2026-11-14): chặn tài khoản phụ cho Boss, mô tả bản đồ bớt nhiễu, skill cho hỏi đáp / họp + truy vết,
// kiểm bản mới của skill, xuất biên bản ra Word, Settings có nút Save trên tiêu đề + tự thu gọn.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { validateSlug } from '../src/agents/accounts.ts';
import { fileSymbols } from '../src/knowledge/map.ts';
import { createSkillsLane, readSkills, skillsFor, turnSkills, SKILLS_KEY } from '../src/skills/lane.ts';
import { buildTicketTrace } from '../src/server/trace.ts';
import { createAskLane } from '../src/server/ask-lane.ts';
import { createMeetingLane, latestMeeting, readMeetings } from '../src/meeting/lane.ts';
import { renderMeetingDocx, zipFiles } from '../src/meeting/docx.ts';
import { unzipEntries } from '../src/meeting/docs.ts';
import type { Meeting } from '../src/meeting/core.ts';
import { readWeb, tmpRepo } from './helpers.ts';

const SKILL = `---\nname: tidy-code\ndescription: "Smallest change for any coding task."\n---\n\n# Tidy\n\nPrefer the simplest working change.\n`;

function world() {
  const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n', 'src/app.js': 'x' });
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  const base = loadConfig('btm.config.yaml');
  const dataDir = mkdtempSync(join(tmpdir(), 'btm-parta-'));
  const agents = { ...base.agents, mb: { tool: 'claude-code', command: 'claude', provider: 'zai', can_sit: ['pm', 'dev', 'qc', 'audit'] } } as any;
  const cfg = { ...base, agents, host: { ...base.host, data_dir: dataDir }, seats: { pm: 'elon', dev: 'jenny', qc: 'elon', audit: 'jenny' } } as Config;
  return { repo, store, cfg, dataDir };
}
/** Đưa thẳng một skill đã duyệt + đang bật vào thư viện (bỏ qua cổng – cổng có test riêng). */
function seedSkill(w: ReturnType<typeof world>, seats: string[], fetchFn?: typeof fetch, source = 'pasted') {
  const lane = createSkillsLane({ cfg: w.cfg, store: w.store, runner: (async () => ({ exitCode: 1, timedOut: false, output: '', lastMessage: '' })) as any, logDir: join(w.dataDir, 'logs'), isolated: true, hostBusy: () => true, fetchFn });
  const r = lane.add(SKILL, source);
  if (!r.ok) throw new Error(r.error);
  w.store.setSetting(SKILLS_KEY, JSON.stringify(readSkills(w.store).map((s) => ({ ...s, status: 'approved', on: true, seats }))));
  return lane;
}

describe('Boss không có tài khoản phụ', () => {
  it('thêm / nhập tài khoản cho agent provider zai bị từ chối; agent thường không đổi', () => {
    const w = world();
    expect(validateSlug(w.cfg, 'mb', 'extra')).toBe('Boss uses an API key, it has no login accounts');
    expect(validateSlug(w.cfg, 'elon', 'extra')).toBeNull();
    expect(readWeb()).toContain("if (w.provider === 'zai') return; // Boss dùng API key, không thêm tài khoản");
  });
});

describe('Bản đồ project: mô tả file bớt nhiễu', () => {
  it('chỉ lấy chú thích đầu file của code / markdown / CSS; bỏ .gitignore, bộ chọn CSS, chú thích giữa file', () => {
    expect(fileSymbols('# local data\n.db\n', '.gitignore').note).toBe('');
    expect(fileSymbols('* {\n  margin: 0;\n}\n', 'public/style.css').note).toBe('');
    expect(fileSymbols('/* Giao diện game */\n* { margin: 0; }\n', 'public/style.css').note).toBe('Giao diện game');
    expect(fileSymbols(`import x from 'y';\n${'const a = 1;\n'.repeat(12)}// Bot at center\n`, 'test/bot.test.js').note).toBe('');
    expect(fileSymbols('// Game logic module\nexport function hit() {}\n', 'public/js/logic.js')).toEqual({ note: 'Game logic module', symbols: ['hit'] });
    expect(fileSymbols('#!/usr/bin/env node\n// Server tĩnh\n', 'server.js').note).toBe('Server tĩnh');
    expect(fileSymbols('# Changelog\n\n## 1.0.0\n', 'CHANGELOG.md').note).toBe('Changelog');
    expect(fileSymbols('{ "name": "x" }', 'package.json').note).toBe('');
  });
});

describe('Skill: truy vết theo lượt + lượt hỏi đáp / họp', () => {
  it('skillsFor ghi tên skill theo lượt; dòng thời gian ticket hiện skill của lượt', () => {
    const w = world();
    seedSkill(w, ['dev']);
    const t = { goal: 'G1', of: 1, number: 1, type: 'feat', size: 'S', scope: ['a.js'], acceptance: ['x'], done_when: 'x', title: 'A' } as any;
    w.store.upsertTicket(w.repo, { ...t, id: 'GT-0001' });
    const sid = w.store.createSession(['1'], w.repo);
    const dev = w.store.startTurn(sid, 'dev', 'jenny', 'GT-0001');
    const qc = w.store.startTurn(sid, 'qc', 'elon', 'GT-0001');
    expect(skillsFor(w.store, w.dataDir, w.repo, 'dev', dev)).toContain('### Skill: tidy-code');
    expect(skillsFor(w.store, w.dataDir, w.repo, 'qc', qc)).toBe('');
    expect(turnSkills(w.store, dev)).toEqual(['tidy-code']);
    expect(turnSkills(w.store, qc)).toEqual([]);
    const turns = buildTicketTrace(w.store, w.repo, 'GT-0001').events.filter((e) => e.kind === 'turn') as any[];
    expect(turns.map((e) => e.skills)).toEqual([['tidy-code'], []]);
    expect(readWeb()).toContain("tx('history.skills', { list: h.skills.join(', ') })");
  });

  it('lượt hỏi đáp và lượt họp nhận skill của ghế', async () => {
    const w = world();
    seedSkill(w, ['pm']);
    const prompts: string[] = [];
    const runner = vi.fn(async (_s: string, _a: string, prompt: string) => {
      prompts.push(prompt);
      return { exitCode: 0, timedOut: false, output: '', lastMessage: prompt.includes('chủ trì kết luận') ? '{"agreed":["a"],"disputed":[],"recommendation":"r","questions":[]}' : '{"points":[{"text":"ý","evidence":{"type":"general","ref":"nhớ"}}]}' };
    });
    const ask = createAskLane({ cfg: w.cfg, store: w.store, runner: runner as any, logDir: join(w.dataDir, 'logs'), isolated: true, hostBusy: () => false });
    w.store.enqueue('ask-pm' as any, 'G1 là gì?');
    await ask.tick();
    expect(prompts[0]).toContain('### Skill: tidy-code');

    const meet = createMeetingLane({ cfg: w.cfg, store: w.store, runner: runner as any, logDir: join(w.dataDir, 'logs'), isolated: true, hostBusy: () => false, fetchFn: (async () => ({ ok: false, text: async () => '' })) as any });
    await meet.start('Chủ đề', true);
    for (let i = 0; i < 80 && readMeetings(w.store, w.repo).some((m) => m.status === 'running'); i++) await new Promise((r) => setTimeout(r, 15));
    expect(latestMeeting(w.store, w.repo)!.status).toBe('done');
    const elonTurn = prompts.find((p) => p.includes('Vòng 1') && p.includes('Góc nhìn của bạn – PM'))!;
    const jennyTurn = prompts.find((p) => p.includes('Vòng 1') && p.includes('Góc nhìn của bạn – Dev'))!;
    expect(elonTurn).toContain('### Skill: tidy-code'); // elon ngồi PM
    expect(jennyTurn).not.toContain('### Skill:'); // jenny ngồi Dev, skill chỉ bật cho PM
  });
});

describe('Skill: kiểm bản mới', () => {
  it('nguồn GitHub không đổi → up to date; đổi → báo có bản mới (không tự thay); skill dán → không có nguồn', async () => {
    const w = world();
    let upstream = SKILL;
    const fake = (async () => ({ ok: true, text: async () => upstream })) as unknown as typeof fetch;
    const lane = seedSkill(w, ['dev'], fake, 'https://github.com/acme/skills · skills/tidy/SKILL.md');
    expect(await lane.checkUpdate(1)).toEqual({ ok: true, changed: false });
    upstream = `${SKILL}\nNew rule.\n`;
    expect(await lane.checkUpdate(1)).toEqual({ ok: true, changed: true, url: 'https://github.com/acme/skills', path: 'skills/tidy/SKILL.md' });
    expect(skillsFor(w.store, w.dataDir, w.repo, 'dev')).not.toContain('New rule.');
    expect(await lane.checkUpdate(99)).toMatchObject({ ok: false, status: 404 });
    const p = world();
    expect(await seedSkill(p, ['dev']).checkUpdate(1)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('Biên bản họp ra Word (.docx)', () => {
  it('file là zip hợp lệ có word/document.xml; chữ được escape; tiêu đề, vòng, dẫn chứng, kết luận đều có', () => {
    const m: Meeting = {
      id: 4, topic: 'Nên dùng <b>X</b> & Y?', quick: false, status: 'done', createdAt: '2026-11-14T01:00:00Z', speakers: [], ownerNotes: [{ at: 't', text: 'ý anh' }],
      turns: [{ round: 1, agent: 'elon', seats: ['pm'], at: 't', points: [{ text: 'Có sẵn hàm start', evidence: { type: 'file', ref: 'src/app.js:1', quote: 'start' }, verified: true }] }],
      conclusion: { by: 'elon', at: 't', agreed: ['dùng X'], disputed: [], recommendation: 'Làm A', questions: [] },
    };
    const buf = renderMeetingDocx(m);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const files = unzipEntries(buf, () => true);
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const xml = files.get('word/document.xml')!.toString('utf8');
    expect(xml).toContain('Nên dùng &lt;b&gt;X&lt;/b&gt; &amp; Y?');
    expect(xml).not.toContain('<b>X</b>');
    for (const text of ['Vòng 1 – Phân tích', 'Có sẵn hàm start', '✓ đã kiểm', 'Kết luận', 'Làm A', 'ý anh']) expect(xml).toContain(text);
    const z = unzipEntries(zipFiles([{ name: 'a.txt', data: Buffer.from('xin chào') }]), () => true);
    expect(z.get('a.txt')!.toString('utf8')).toBe('xin chào');
  });
});

describe('Settings: nút Save trên tiêu đề + tự thu gọn', () => {
  const html = readWeb();
  it('có nút Save cạnh tiêu đề, mũi tên thu gọn, tự đóng sau 5 phút, mở bằng mục Settings trên sidebar', () => {
    for (const id of ['settings-save-top', 'settings-feedback-top', 'settings-toggle']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('var SETTINGS_COLLAPSE_MS = 5 * 60 * 1000;');
    expect(html).toContain("var saveButtons = [$('settings-save'), $('settings-save-top')].filter(Boolean);");
    expect(html).toContain("if (nav) nav.addEventListener('click', function () { setOpen(true); });");
    expect(html).toContain('.settings-section.settings-collapsed > :not(.sec-head) { display: none !important; }');
    expect(html).toContain("['docx', 'meet.exportDocx']");
    expect(html).toContain("action: 'check-update'");
  });
});

describe('Meeting room: dọn phòng + nhận câu tranh luận (anh Zon 2026-11-14)', () => {
  const html = readWeb();
  it('câu "có nên…" / "should we…" / "A hay B" → debate; câu hỏi thường không đổi', () => {
    const lib = new Function(html.slice(html.indexOf('var CHAT_LINES'), html.indexOf('// end chat-lib')) + 'return { classifyMessage };')() as any;
    expect(lib.classifyMessage('Có nên cho trẻ em học tiếng Anh sớm trước lớp 4', {}).kind).toBe('debate');
    expect(lib.classifyMessage('Should we rewrite the server in Rust?', {}).kind).toBe('debate');
    expect(lib.classifyMessage('Dùng React hay là Vue cho dashboard?', {}).kind).toBe('debate');
    expect(lib.classifyMessage('Tranh luận: monorepo có tốt không', {}).kind).toBe('debate');
    expect(lib.classifyMessage('G1 làm tới đâu rồi?', {}).kind).toBe('ask');
    expect(lib.classifyMessage('thêm nút xoá vào trang chủ', {}).kind).toBe('goal');
    expect(html).toContain("if (how === true || how === 'alt') {");
    expect(html).toContain("postJson('/api/meeting', { action: 'start', topic: text, quick: how === 'alt' })");
  });

  it('dọn phòng: tin trước mốc bị ẩn (có dòng "đã ẩn N tin" + Hiện lại); họp đang chạy và phiên đang chạy vẫn hiện', () => {
    const src = html.slice(html.indexOf('function roomFilter'), html.indexOf('var HIST_ICON'));
    const roomFilter = new Function(src + 'return roomFilter;')();
    const items = [
      { kind: 'ask', id: 1, at: '2026-11-14T01:00:00Z' },
      { kind: 'reply', id: 1, at: '2026-11-14T01:01:00Z' },
      { kind: 'goal', text: 'G1' },
      { kind: 'ask', id: 2, at: '2026-11-14T03:00:00Z' },
      { kind: 'meet-head', id: 'M1', at: '2026-11-14T00:30:00Z' },
    ];
    const state = { settings: { roomClearedAt: '2026-11-14T02:00:00Z' }, session: { status: 'done' }, meeting: { status: 'done', createdAt: '2026-11-14T00:30:00Z' } };
    const out = roomFilter(items, state);
    expect(out.map((x: any) => x.kind)).toEqual(['room-cleared', 'ask']);
    expect(out[0].n).toBe(4);
    const live = roomFilter(items, { ...state, session: { status: 'running' }, meeting: { status: 'running', createdAt: '2026-11-14T00:30:00Z' } });
    expect(live.map((x: any) => x.kind)).toEqual(['room-cleared', 'goal', 'ask', 'meet-head']);
    expect(roomFilter(items, { settings: {} })).toBe(items);
    for (const id of ['room-clear']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("postJson('/api/meeting-room', { action: 'clear' })");
    expect(html).toContain("postJson('/api/meeting-room', { action: 'show' })");
  });

  it('lời nhắc họp: chủ đề ngoài project dùng kiến thức chung có nguồn; bản đồ project chỉ khi liên quan', async () => {
    const { meetingPrompt } = await import('../src/meeting/core.ts');
    const m = { id: 1, topic: 'Có nên cho trẻ em học tiếng Anh sớm?', quick: true, status: 'running', createdAt: 't', speakers: [{ agent: 'a', seats: ['pm'] }], turns: [], ownerNotes: [] } as any;
    const p = meetingPrompt(m, m.speakers[0], 1, { material: '', knowledge: '- a.js', name: 'Finn' });
    expect(p).toContain('Vấn đề không thuộc project này');
    expect(p).toContain('chỉ dùng khi vấn đề liên quan tới project này');
  });
});

describe('Meeting room: avatar nhỏ đầu mỗi tin (anh Zon 2026-11-14)', () => {
  const html = readWeb();
  it('ảnh agent nếu có, không thì chữ cái đầu; anh Zon là "Z"; gắn đầu dòng tiêu đề ở tin hỏi đáp và lượt họp', () => {
    expect(html).toContain("e.src = '/api/avatar/' + encodeURIComponent(agent) + '?v=' + encodeURIComponent(ver);");
    expect(html).toContain("e.textContent = String(owner ? 'Z' : (label || agent || '?')).charAt(0).toUpperCase();");
    expect(html).toContain("withAvatar(head, avAgent, it.kind === 'ask' ? 'Zon' : who(it.seat, it.agent), av);");
    expect(html).toContain('d.renderMeetItem(li, it, state);');
    expect(html).toMatch(/\.chat-log \.msg-avatar \{ width: calc\(22px \* var\(--chat-zoom, 1\)\)/);
    expect(html.slice(html.indexOf('function chatAvatarEl'), html.indexOf('function meetEvidenceMark'))).not.toContain('innerHTML');
  });
});
