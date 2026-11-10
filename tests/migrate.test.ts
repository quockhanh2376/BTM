import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo } from './helpers.ts';
import { git, headSha } from '../src/git.ts';
import { openStore } from '../src/store/db.ts';
import { migrateProject } from '../src/project/migrate.ts';
import { acquireLock, main } from '../src/cli.ts';

const AUTHOR = ['-c', 'user.name=test', '-c', 'user.email=test@btm.local'];

describe('migrateProject', () => {
  it('chuyển đổi project kiểu cũ: tạo project.yaml và .gitkeep trên main, giữ nguyên session/3 và team/tasks/', () => {
    // Project cũ có team/tasks/T-001.md
    const repo = tmpRepo({
      'README.md': '# Old Project',
      'team/tasks/T-001.md': '---\nid: T-001\ntitle: Task 1\n---\nNội dung task cũ',
    });

    const mainShaBefore = headSha(repo);

    // Tạo nhánh session/3 và có commit riêng
    git(repo, 'checkout', '-b', 'session/3');
    writeFileSync(join(repo, 'feature.txt'), 'dang lam o session 3\n');
    git(repo, 'add', 'feature.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'wip: session 3 work'], { cwd: repo });

    const session3ShaBefore = headSha(repo);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('session/3');

    // Chạy migrate
    const res = migrateProject(repo, 'GTM', 'main');
    expect(res).toEqual({ ok: true, already: false, previousBranch: 'session/3' });

    // 1. Sau migrate nhánh hiện tại là main
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');

    // 2. session/3 không đổi (so sha)
    const session3ShaAfter = git(repo, 'rev-parse', 'session/3').trim();
    expect(session3ShaAfter).toBe(session3ShaBefore);

    // 3. team/tasks/T-001.md vẫn còn nguyên
    expect(existsSync(join(repo, 'team', 'tasks', 'T-001.md'))).toBe(true);
    expect(readFileSync(join(repo, 'team', 'tasks', 'T-001.md'), 'utf8')).toContain('Task 1');

    // 4. main có commit mới với thông điệp migrate: project key GTM và author btm <btm@btm.local>
    const mainLog = git(repo, 'log', 'main', '-n', '1', '--format=%s%n%an <%ae>').trim();
    expect(mainLog).toBe('migrate: project key GTM\nbtm <btm@btm.local>');

    const mainShaAfter = git(repo, 'rev-parse', 'main').trim();
    expect(mainShaAfter).not.toBe(mainShaBefore);

    // 5. Nội dung trên main có team/project.yaml, team/tickets/.gitkeep, team/goals/.gitkeep
    const projectYamlOnMain = git(repo, 'show', 'main:team/project.yaml');
    expect(projectYamlOnMain).toBe('key: GTM\n');

    expect(git(repo, 'ls-tree', 'main', 'team/tickets/.gitkeep')).toContain('.gitkeep');
    expect(git(repo, 'ls-tree', 'main', 'team/goals/.gitkeep')).toContain('.gitkeep');
  });

  it('chạy lần 2 với cùng KEY → already: true, ở lại main, không tạo commit mới trên main', () => {
    const repo = tmpRepo({
      'README.md': '# Project',
      'team/tasks/T-001.md': '# Task 1',
    });

    const res1 = migrateProject(repo, 'GTM', 'main');
    expect(res1).toEqual({ ok: true, already: false, previousBranch: 'main' });
    const mainShaAfter1 = git(repo, 'rev-parse', 'main').trim();

    // Chuyển sang nhánh khác
    git(repo, 'checkout', '-b', 'session/4');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('session/4');

    // Chạy lần 2
    const res2 = migrateProject(repo, 'GTM', 'main');
    expect(res2).toEqual({ ok: true, already: true, previousBranch: 'session/4' });

    // main SHA không đổi
    const mainShaAfter2 = git(repo, 'rev-parse', 'main').trim();
    expect(mainShaAfter2).toBe(mainShaAfter1);

    // Nhánh hiện tại ở lại main
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('KEY khác → báo lỗi, không commit gì mới', () => {
    const repo = tmpRepo({
      'README.md': '# Project',
    });

    migrateProject(repo, 'GTM', 'main');
    const mainShaBefore = git(repo, 'rev-parse', 'main').trim();

    expect(() => {
      migrateProject(repo, 'ABC', 'main');
    }).toThrow(/already has key "GTM", cannot migrate to "ABC"/);

    expect(git(repo, 'rev-parse', 'main').trim()).toBe(mainShaBefore);
  });

  it('working tree bẩn → báo lỗi, không commit, không đổi gì', () => {
    const repo = tmpRepo({
      'README.md': '# Clean Project',
    });
    const mainShaBefore = headSha(repo);

    // Tạo file untracked làm bẩn tree
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted content');

    expect(() => {
      migrateProject(repo, 'GTM', 'main');
    }).toThrow(/working tree is dirty/i);

    expect(headSha(repo)).toBe(mainShaBefore);
    expect(existsSync(join(repo, 'team', 'project.yaml'))).toBe(false);
  });

  it('KEY sai định dạng → báo lỗi, không đổi gì', () => {
    const repo = tmpRepo({
      'README.md': '# Clean Project',
    });
    const mainShaBefore = headSha(repo);

    const invalidKeys = ['gtm', 'G', 'TOOLONGKEY', '123', '', 'G-T'];
    for (const badKey of invalidKeys) {
      expect(() => {
        migrateProject(repo, badKey, 'main');
      }).toThrow(/invalid project key/i);
    }

    expect(headSha(repo)).toBe(mainShaBefore);
    expect(existsSync(join(repo, 'team', 'project.yaml'))).toBe(false);
  });

  it('lỗi commit giữa chừng sau khi đã checkout protected branch → trả lại nhánh cũ, main không đổi, dọn dẹp file dở dang', async () => {
    const repo = tmpRepo({
      'README.md': '# Old Project',
    });
    const mainShaBefore = headSha(repo);

    // Tạo nhánh session/2
    git(repo, 'checkout', '-b', 'session/2');
    writeFileSync(join(repo, 'task.txt'), 'session 2 work\n');
    git(repo, 'add', 'task.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'wip: session 2'], { cwd: repo });
    const session2ShaBefore = headSha(repo);

    // Tạo mock git khiến lệnh commit sau checkout thất bại
    const gitModule = await import('../src/git.ts');
    const originalGit = gitModule.git;
    const gitSpy = vi.spyOn(gitModule, 'git').mockImplementation((r, ...args) => {
      if (args.includes('commit') && args.includes('migrate: project key GTM')) {
        throw new Error('Simulated git commit failure');
      }
      return originalGit(r, ...args);
    });

    expect(() => {
      migrateProject(repo, 'GTM', 'main');
    }).toThrow('Simulated git commit failure');

    gitSpy.mockRestore();

    // 1. Nhánh hiện tại phải được trả về session/2
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('session/2');
    expect(headSha(repo)).toBe(session2ShaBefore);

    // 2. main không đổi
    expect(git(repo, 'rev-parse', 'main').trim()).toBe(mainShaBefore);

    // 3. Không để lại file team/project.yaml nửa vời
    expect(existsSync(join(repo, 'team', 'project.yaml'))).toBe(false);

    // 4. Working tree sạch
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });
});

describe('CLI btm migrate', () => {
  let tmpRoot: string;
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'btm-migrate-cli-root-'));
    dataDir = mkdtempSync(join(tmpdir(), 'btm-migrate-cli-data-'));
    configPath = join(dataDir, 'test-btm.config.yaml');

    // Copy btm.config.yaml đầy đủ của repo rồi chỉ đổi host.*
    const baseYaml = readFileSync(join(process.cwd(), 'btm.config.yaml'), 'utf8');
    const cfgContent = baseYaml
      .replace(/projects_root:\s*.*/, `projects_root: ${tmpRoot.replace(/\\/g, '/')}`)
      .replace(/data_dir:\s*.*/, `data_dir: ${dataDir.replace(/\\/g, '/')}`);
    writeFileSync(configPath, cfgContent, 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('btm migrate --key GTM chạy cho project active, lấy khoá và trả mã 0', async () => {
    const projectDir = tmpRepo({
      'README.md': '# Old Project',
      'team/tasks/T-001.md': '# Old Task',
    });

    // Đặt active project trong db
    const dbPath = join(dataDir, 'btm.db');
    const store = openStore(dbPath);
    store.setActiveProject(projectDir);
    store.close();

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await main(['migrate', '--key', 'GTM', '--config', configPath]);
    expect(exitCode).toBe(0);

    const logOutput = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('Migrated project');
    expect(logOutput).toContain('Đã chuyển sang main');

    // Kiểm tra file project.yaml trên main
    expect(existsSync(join(projectDir, 'team', 'project.yaml'))).toBe(true);
    expect(readFileSync(join(projectDir, 'team', 'project.yaml'), 'utf8')).toBe('key: GTM\n');

    const storeCheck = openStore(dbPath);
    const mainShaAfterMigrate = git(projectDir, 'rev-parse', 'refs/heads/main').trim();
    expect(storeCheck.getSetting(`protected_sha:${projectDir}`)).toBe(mainShaAfterMigrate);
    storeCheck.close();

    // Chạy lần 2 báo already migrated
    const exitCode2 = await main(['migrate', '--key', 'GTM', '--config', configPath]);
    expect(exitCode2).toBe(0);
    const logOutput2 = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput2).toContain('already migrated');
    expect(logOutput2).toContain('Đã chuyển sang main');
  });

  it('btm migrate đang có phiên (bị khoá btm.lock) → lỗi và trả mã 1, không đổi gì', async () => {
    const projectDir = tmpRepo({ 'README.md': '# Locked Project' });

    const dbPath = join(dataDir, 'btm.db');
    const store = openStore(dbPath);
    store.setActiveProject(projectDir);
    store.close();

    // Giữ khoá btm.lock
    const releaseLock = acquireLock(dataDir);
    expect(releaseLock).not.toBeNull();

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const exitCode = await main(['migrate', '--key', 'GTM', '--config', configPath]);
      expect(exitCode).toBe(1);

      const errOutput = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(errOutput).toMatch(/đang có phiên|Another btm process is running/);
    } finally {
      releaseLock?.();
    }
  });

  it('btm migrate không có --key hoặc key sai → trả mã 1', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const codeNoKey = await main(['migrate', '--config', configPath]);
    expect(codeNoKey).toBe(1);

    const codeBadKey = await main(['migrate', '--key', 'badkey', '--config', configPath]);
    expect(codeBadKey).toBe(1);
  });

  it('btm migrate chưa có active project → trả mã 1', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await main(['migrate', '--key', 'GTM', '--config', configPath]);
    expect(code).toBe(1);

    const errOutput = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toContain('No active project set');
  });

  it('btm main accept ghim lại sha main hiện tại của project active và in "pin <cũ> → <mới>"', async () => {
    const projectDir = tmpRepo({ 'README.md': '# Project' });
    const dbPath = join(dataDir, 'btm.db');
    const store = openStore(dbPath);
    store.setActiveProject(projectDir);
    store.close();

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const migCode = await main(['migrate', '--key', 'GTM', '--config', configPath]);
    expect(migCode).toBe(0);

    const oldSha = git(projectDir, 'rev-parse', 'refs/heads/main').trim();
    writeFileSync(join(projectDir, 'README.md'), '# Project updated by owner\n', 'utf8');
    git(projectDir, 'add', 'README.md');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'owner manual commit on main'], { cwd: projectDir });
    const newSha = git(projectDir, 'rev-parse', 'refs/heads/main').trim();
    expect(newSha).not.toBe(oldSha);

    consoleLogSpy.mockClear();
    const acceptCode = await main(['main', 'accept', '--config', configPath]);
    expect(acceptCode).toBe(0);

    const logOutput = consoleLogSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain(`pin ${oldSha} → ${newSha}`);

    const storeAfter = openStore(dbPath);
    expect(storeAfter.getSetting(`protected_sha:${projectDir}`)).toBe(newSha);
    storeAfter.close();
  });
});
