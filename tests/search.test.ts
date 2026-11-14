import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { foldText, matchItems, searchBtm } from '../src/server/search.ts';
import { tmpRepo } from './helpers.ts';

function setup() {
  const repo = tmpRepo({ 'team/project.yaml': 'key: GT\n', 'README.md': 'x' });
  const store = openStore(':memory:');
  store.setActiveProject(repo);
  const base = loadConfig('btm.config.yaml');
  const cfg = { ...base, host: { ...base.host, data_dir: mkdtempSync(join(tmpdir(), 'btm-search-')) } } as Config;
  store.createGoal(repo, 'Mini game bắn máy bay');
  store.createGoal(repo, 'Boss và âm thanh');
  const t = { goal: 'G1', of: 1, type: 'security', size: 'S', scope: ['server.js'], acceptance: ['x'], done_when: 'x' } as any;
  store.upsertTicket(repo, { ...t, id: 'GT-0007', number: 1, title: 'Sửa lỗi DoS null byte' });
  return { repo, store, cfg };
}

describe('Ô Search (2026-11-14)', () => {
  it('bỏ dấu + chữ thường, giữ độ dài', () => {
    expect(foldText('Trời MƯA đỏ Đen')).toBe('troi mua do den');
    expect(foldText('Lỗi ở GT-0007').length).toBe('Lỗi ở GT-0007'.length);
  });

  it('mọi từ phải khớp; đoạn trích lấy quanh chỗ khớp', () => {
    const items = [
      { kind: 'log' as const, title: 'gate', text: 'x'.repeat(400) + ' lỗi timeout khi chạy test ' + 'y'.repeat(400) },
      { kind: 'log' as const, title: 'gate', text: 'ok' },
    ];
    const r = matchItems(items, ['loi', 'timeout']);
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toContain('lỗi timeout');
    expect(r[0]!.text.length).toBeLessThan(260);
    expect(matchItems(items, [])).toEqual([]);
  });

  it('"G1 là project gì" → G1 + nhật ký đứng đầu; tìm không dấu ra ticket; goal trong thùng rác bị bỏ', () => {
    const s = setup();
    const r = searchBtm(s.store, s.cfg, 'G1 là project gì');
    expect(r[0]).toMatchObject({ kind: 'goal', title: 'G1 · Mini game bắn máy bay' });
    expect(r[1]!.kind).toBe('history');
    expect(r[1]!.text).toContain('Mini game');
    expect(r.some((h) => h.title.startsWith('G2'))).toBe(false);

    const t = searchBtm(s.store, s.cfg, 'loi dos');
    expect(t.some((h) => h.kind === 'ticket' && h.title.startsWith('GT-0007'))).toBe(true);

    expect(searchBtm(s.store, s.cfg, 'am thanh').some((h) => h.title.startsWith('G2'))).toBe(true);
    s.store.archiveGoal(s.repo, 2);
    expect(searchBtm(s.store, s.cfg, 'am thanh').some((h) => h.title.startsWith('G2'))).toBe(false);
    expect(searchBtm(s.store, s.cfg, '   ')).toEqual([]);
  });
});
