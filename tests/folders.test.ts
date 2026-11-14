import { describe, expect, it } from 'vitest';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { readFolders, parseWorkspaceOut, MAX_FILES } from '../src/server/folders.ts';
import { tmpRepo } from './helpers.ts';

describe('Tab Folder: đọc cấu trúc thư mục (chỉ xem)', () => {
  it('đọc kết quả lệnh worker: project, giờ đồng bộ, số file sửa dở, danh sách file', () => {
    const v = parseWorkspaceOut('@projects\ngametest-btm\n@synced\n1794610000\n@dirty\n2\n@files\nserver.js\npublic/a\x1b.js\n');
    expect(v.projects).toEqual(['gametest-btm']);
    expect(v.syncedAt).toBe(new Date(1794610000 * 1000).toISOString());
    expect(v.dirty).toBe(2);
    expect(v.files).toEqual(['server.js', 'public/a.js']);
    expect(parseWorkspaceOut('@projects\n@synced\n@dirty\n@files\n')).toMatchObject({ syncedAt: null, dirty: null, files: [] });
  });

  it('cắt danh sách ở MAX_FILES và báo truncated', () => {
    const v = parseWorkspaceOut('@files\n' + Array.from({ length: MAX_FILES + 1 }, (_, i) => `f${i}`).join('\n'));
    expect(v.files.length).toBe(MAX_FILES);
    expect(v.truncated).toBe(true);
  });

  it('repo chính qua git; mỗi account đọc qua sudo user worker, lỗi một account không làm hỏng cả trang', async () => {
    const repo = tmpRepo({ 'README.md': 'x', 'src/a.js': 'y' });
    const store = openStore(':memory:');
    store.setActiveProject(repo);
    const c = loadConfig('btm.config.yaml');
    const cfg = { ...c, host: { ...c.host, worker_prefix: 'btm-', work_root: '/srv/btm-work', trusted_root: '/srv/btm-repos' } } as Config;
    store.ensureDefaultAccounts(Object.keys(cfg.agents));
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args.includes('btm-elon')) throw new Error('no dir');
      return '@projects\nx\n@synced\n1\n@dirty\n0\n@files\nREADME.md\n';
    };
    const v = await readFolders(cfg, store, exec);
    expect(v.repo?.files.sort()).toEqual(['README.md', 'src/a.js']);
    expect(v.repo?.commit?.sha).toHaveLength(7);
    expect(v.accounts.length).toBe(Object.keys(cfg.agents).length);
    for (const call of calls) expect(call.slice(0, 4)).toEqual(['sudo', '-n', '-u', call[3]]);
    expect(calls.every((c) => c[3]!.startsWith('btm-') && c.includes('/usr/local/bin/btm-worker-exec'))).toBe(true);
    expect(v.accounts.find((a) => a.key === 'elon')?.error).toBeTruthy();
    expect(v.accounts.find((a) => a.key === 'jacky')?.files).toEqual(['README.md']);
  });
});
