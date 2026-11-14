import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.ts';
import { buildProjectMap, fileSymbols, mapForScope, regressionTickets, MAP_PM_MAX } from '../src/knowledge/map.ts';
import { parseTicket } from '../src/ticket/ticket.ts';
import { tmpRepo } from './helpers.ts';

const ticket = (id: string, n: number, scope: string[]) => `---
id: ${id}
goal: G1
number: ${n}
of: 3
title: "T ${id}"
type: feat
size: S
scope: [${scope.map((s) => `"${s}"`).join(', ')}]
acceptance: ["ok"]
done_when: "ok"
---
`;

function setup() {
  const repo = tmpRepo({
    'team/project.yaml': 'key: GT\n',
    'README.md': '# Game\n\nMini game bắn máy bay chạy trên trình duyệt.\n',
    'public/js/logic.js': '// Luật chơi: va chạm, điểm\nfunction hit(a, b) {}\nfunction score() {}\nmodule.exports = { hit, score };\n',
    'public/js/bot.js': '/* Bot tự bắn */\nexport function aim() {}\nexport const SPEED = 3;\n',
    'server.js': '#!/usr/bin/env node\n// Server tĩnh\nconst x = 1;\n',
    'tools/x.py': '# Công cụ\ndef run():\n    pass\ndef _hidden():\n    pass\nclass Thing:\n    pass\n',
    'public/logo.png': 'PNG',
    'team/tickets/GT-0001.md': ticket('GT-0001', 1, ['public/js/']),
    'team/tickets/GT-0002.md': ticket('GT-0002', 2, ['public/js/logic.js']),
    'team/tickets/GT-0003.md': ticket('GT-0003', 3, ['public/js/logic.js', 'server.js']),
    'team/tickets/GT-0009.md': '---\nnot: valid ticket\n---\n',
  });
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  store.createGoal(repo, 'Game bắn máy bay');
  return { repo, store };
}

describe('Bản đồ project (2026-11-14)', () => {
  it('symbol: JS export / module.exports / Python; ghi chú dòng đầu; bỏ shebang', () => {
    expect(fileSymbols('// Luật\nfunction a(){}\nmodule.exports = { a, b: 1 };', 'x.js')).toEqual({ note: 'Luật', symbols: ['a', 'b'] });
    expect(fileSymbols('#!/usr/bin/env node\n// Server\n', 's.js').note).toBe('Server');
    expect(fileSymbols('def run():\n  pass\ndef _x():\n  pass', 'a.py').symbols).toEqual(['run']);
    expect(fileSymbols('export async function go() {}\nexport class K {}', 'a.ts').symbols).toEqual(['go', 'K']);
    expect(fileSymbols('hello', 'a.md').symbols).toEqual([]);
  });

  it('cả project: README, goal, module + hàm có sẵn + ticket đã sửa (scope thư mục khớp file bên trong); bỏ team/ và ảnh; ticket lỗi không làm hỏng', () => {
    const { repo, store } = setup();
    const m = buildProjectMap(store, repo);
    expect(m).toContain('Mô tả (README): Mini game bắn máy bay chạy trên trình duyệt.');
    expect(m).toContain('- G1 Game bắn máy bay → open, 3 ticket');
    expect(m).toContain('- public/js/logic.js — Luật chơi: va chạm, điểm · có: hit, score · sửa bởi: GT-0001 (G1), GT-0002 (G1), GT-0003 (G1)');
    expect(m).toContain('- public/js/bot.js — Bot tự bắn · có: aim, SPEED · sửa bởi: GT-0001 (G1)');
    expect(m).toContain('- tools/x.py — Công cụ · có: run, Thing');
    expect(m).not.toContain('team/tickets');
    expect(m).not.toContain('logo.png');
    const short = buildProjectMap(store, repo, 100);
    expect(short.length).toBe(100);
    expect(short.endsWith('…')).toBe(true);
    expect(buildProjectMap(store, repo).length).toBeLessThanOrEqual(12000);
    expect(MAP_PM_MAX).toBe(4000);
  });

  it('Dev: chỉ file trong scope; QC: ticket cũ hơn cùng file, không gồm chính nó', () => {
    const { repo } = setup();
    const dev = mapForScope(repo, ['public/js/logic.js']);
    expect(dev).toContain('public/js/logic.js');
    expect(dev).not.toContain('bot.js');
    expect(mapForScope(repo, ['public/js/'])).toContain('bot.js');
    const t3 = parseTicket(ticket('GT-0003', 3, ['public/js/logic.js', 'server.js']), 'GT');
    expect(regressionTickets(repo, t3)).toEqual(['GT-0001', 'GT-0002']);
    const t1 = parseTicket(ticket('GT-0001', 1, ['public/js/']), 'GT');
    expect(regressionTickets(repo, t1)).toEqual([]);
  });

  it('repo không có project.yaml → rỗng, không throw', () => {
    const repo = tmpRepo({ 'a.js': 'x' });
    expect(buildProjectMap(openStore(':memory:'), repo)).toBe('');
    expect(mapForScope(repo, ['a.js'])).toBe('');
  });
});

describe('Bản đồ project: prompt + search (2026-11-14)', () => {
  it('PM nhận bản đồ; Dev nhận phần scope; QC nhận ticket cũ cùng file; rỗng thì không thêm dòng', async () => {
    const { pmTicketPrompt, devTicketPrompt, qcTicketPrompt } = await import('../src/core/prompts.ts');
    const t = parseTicket(ticket('GT-0003', 3, ['public/js/logic.js']), 'GT');
    expect(pmTicketPrompt({ n: 2, title: 'x' }, 'GT', 'GT-0010', { map: '- a.js · có: f' })).toContain('Dùng lại module/hàm có sẵn');
    expect(pmTicketPrompt({ n: 2, title: 'x' }, 'GT', 'GT-0010', { map: '' })).not.toContain('Bản đồ project');
    expect(devTicketPrompt(t, 'jenny', [], [], false, '- public/js/logic.js · có: hit')).toContain('xem đã có sẵn chưa');
    expect(devTicketPrompt(t, 'jenny')).not.toContain('Bản đồ file');
    expect(qcTicketPrompt(t, 'abc', 'elon', [], ['GT-0001', 'GT-0002'])).toContain('Kiểm hồi quy: các ticket cũ GT-0001, GT-0002');
    expect(qcTicketPrompt(t, 'abc', 'elon')).not.toContain('Kiểm hồi quy');
  });

  it('ô search tìm thấy file / hàm trong bản đồ', async () => {
    const { searchBtm } = await import('../src/server/search.ts');
    const { loadConfig } = await import('../src/config.ts');
    const { repo, store } = setup();
    const hits = searchBtm(store, loadConfig('btm.config.yaml'), 'score');
    expect(hits.some((h) => h.kind === 'map' && h.text.includes('public/js/logic.js'))).toBe(true);
    expect(repo).toBeTruthy();
  });
});
