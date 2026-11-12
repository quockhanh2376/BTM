import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxPath, detectImage, readInboxFile, removeInboxFromMain } from '../src/server/inbox.js';
import { execFileSync } from 'node:child_process';
import { tmpRepo } from './helpers.ts';

describe('inboxPath', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'btm-inbox-test-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('accepts valid note and image names and returns absolute path', () => {
    const p1 = inboxPath(projectDir, 'N-1.md');
    expect(p1).toBe(join(projectDir, 'team', 'inbox', 'N-1.md'));

    const p2 = inboxPath(projectDir, 'N-42.png');
    expect(p2).toBe(join(projectDir, 'team', 'inbox', 'N-42.png'));

    const p3 = inboxPath(projectDir, 'N-100.jpg');
    expect(p3).toBe(join(projectDir, 'team', 'inbox', 'N-100.jpg'));

    const p4 = inboxPath(projectDir, 'N-999.webp');
    expect(p4).toBe(join(projectDir, 'team', 'inbox', 'N-999.webp'));

    const p5 = inboxPath(projectDir, 'N-12');
    expect(p5).toBe(join(projectDir, 'team', 'inbox', 'N-12'));
  });

  it('rejects strange or invalid names', () => {
    const invalidNames = [
      'bad.txt',
      'N-abc.md',
      'N-1.jpeg',
      '../N-1.md',
      'N-1.gif',
      'N-.md',
      '',
      'N-1.md.bak',
      '1.md',
      'team/inbox/N-1.md',
      'N-1/image.png',
    ];

    for (const name of invalidNames) {
      expect(() => inboxPath(projectDir, name)).toThrow();
    }
  });

  it('rejects when team/inbox is a symlink pointing outside project', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'btm-outside-'));
    try {
      mkdirSync(join(projectDir, 'team'), { recursive: true });
      symlinkSync(outsideDir, join(projectDir, 'team', 'inbox'));
      expect(() => inboxPath(projectDir, 'N-1.md')).toThrow(/inside project/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects and does not create outside directory when team is a symlink pointing outside project and inbox does not exist', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'btm-outside-'));
    try {
      symlinkSync(outsideDir, join(projectDir, 'team'));
      expect(() => inboxPath(projectDir, 'N-1.md')).toThrow(/inside project/i);
      expect(existsSync(join(outsideDir, 'inbox'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects when target file exists and is a symlink', () => {
    const inboxDir = join(projectDir, 'team', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const outsideFile = join(tmpdir(), `btm-dummy-${Date.now()}.txt`);
    writeFileSync(outsideFile, 'dummy');

    try {
      const symlinkTarget = join(inboxDir, 'N-1.md');
      symlinkSync(outsideFile, symlinkTarget);
      expect(() => inboxPath(projectDir, 'N-1.md')).toThrow(/symlink/i);
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it('allows existing regular file', () => {
    const inboxDir = join(projectDir, 'team', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const file = join(inboxDir, 'N-1.md');
    writeFileSync(file, 'hello');

    const result = inboxPath(projectDir, 'N-1.md');
    expect(result).toBe(file);
  });
});

describe('detectImage', () => {
  it('detects PNG with exactly 8 magic bytes (89 50 4E 47 0D 0A 1A 0A)', () => {
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(detectImage(validPng)).toEqual({ ext: 'png', mime: 'image/png' });

    // Only 4 bytes -> not valid
    const truncatedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(detectImage(truncatedPng)).toBeNull();

    // 8 bytes with corrupt last byte
    const corruptPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]);
    expect(detectImage(corruptPng)).toBeNull();
  });

  it('detects JPEG (FF D8 FF) and always returns ext jpg', () => {
    const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImage(validJpeg)).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
  });

  it('detects WebP (RIFF....WEBP)', () => {
    const validWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x20, 0x00, 0x00, 0x00, // file size
      0x57, 0x45, 0x42, 0x50, // WEBP
    ]);
    expect(detectImage(validWebp)).toEqual({ ext: 'webp', mime: 'image/webp' });

    // Missing WEBP
    const invalidWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x20, 0x00, 0x00, 0x00,
      0x41, 0x42, 0x43, 0x44,
    ]);
    expect(detectImage(invalidWebp)).toBeNull();
  });

  it('returns null for unknown buffer', () => {
    expect(detectImage(Buffer.from('not an image'))).toBeNull();
    expect(detectImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('readInboxFile', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@btm.local', ...args], { cwd });

  it('đọc file trong working tree', () => {
    const repo = tmpRepo({});
    mkdirSync(join(repo, 'team', 'inbox'), { recursive: true });
    writeFileSync(join(repo, 'team', 'inbox', 'N-1.png'), PNG);
    expect(readInboxFile(repo, 'N-1.png')?.equals(PNG)).toBe(true);
  });

  it('file chỉ nằm trên nhánh khác (note đã huỷ) → đọc từ git, đúng từng byte', () => {
    const repo = tmpRepo({});
    git(repo, 'checkout', '-q', '-b', 'session/1');
    mkdirSync(join(repo, 'team', 'inbox'), { recursive: true });
    writeFileSync(join(repo, 'team', 'inbox', 'N-2.png'), PNG);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'inbox N-2');
    git(repo, 'checkout', '-q', 'main');
    expect(existsSync(join(repo, 'team', 'inbox', 'N-2.png'))).toBe(false);
    expect(readInboxFile(repo, 'N-2.png')?.equals(PNG)).toBe(true);
  });

  it('không có ở đâu → null; tên không hợp lệ → null', () => {
    const repo = tmpRepo({});
    expect(readInboxFile(repo, 'N-9.png')).toBeNull();
    expect(readInboxFile(repo, '../x.png')).toBeNull();
  });
});

describe('removeInboxFromMain', () => {
  const g = (repo: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();

  it('xoá note + ảnh trên main, commit owner, quay lại nhánh cũ; tên lạ bị bỏ qua', () => {
    const repo = tmpRepo({ 'team/inbox/N-1.md': 'a', 'team/inbox/N-1.png': 'p', 'team/inbox/N-2.md': 'b', 'src/x.ts': '1' });
    const pinned = g(repo, 'rev-parse', 'main');
    g(repo, 'checkout', '-qb', 'goal/G1-x');
    const { mainSha, removed } = removeInboxFromMain(repo, ['N-1.md', 'N-1.png', 'N-9.md', '../src/x.ts'], 'main', pinned);
    expect(removed).toEqual(['team/inbox/N-1.md', 'team/inbox/N-1.png']);
    expect(mainSha).toBe(g(repo, 'rev-parse', 'main'));
    expect(mainSha).not.toBe(pinned);
    expect(g(repo, 'ls-tree', '-r', '--name-only', 'main')).toBe(['src/x.ts', 'team/inbox/N-2.md'].join('\n'));
    expect(g(repo, 'log', '-1', '--format=%an %s', 'main')).toBe('owner inbox: delete N-1');
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('goal/G1-x');
    expect(existsSync(join(repo, 'team/inbox/N-1.md'))).toBe(true); // nhánh goal giữ nguyên
  });

  it('không có gì để xoá → không commit; main lệch ghim / cây bẩn → lỗi, không đổi gì', () => {
    const repo = tmpRepo({ 'team/inbox/N-1.md': 'a' });
    const pinned = g(repo, 'rev-parse', 'main');
    expect(removeInboxFromMain(repo, ['N-5.md'], 'main', pinned)).toEqual({ mainSha: pinned, removed: [] });
    expect(() => removeInboxFromMain(repo, ['N-1.md'], 'main', 'deadbeef')).toThrow('protected_branch_moved');
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    expect(() => removeInboxFromMain(repo, ['N-1.md'], 'main', pinned)).toThrow('dirty');
    expect(g(repo, 'rev-parse', 'main')).toBe(pinned);
  });

  it('đang đứng trên main: xoá cả file trong cây làm việc', () => {
    const repo = tmpRepo({ 'team/inbox/N-1.md': 'a' });
    const { removed } = removeInboxFromMain(repo, ['N-1.md'], 'main', '');
    expect(removed).toEqual(['team/inbox/N-1.md']);
    expect(existsSync(join(repo, 'team/inbox/N-1.md'))).toBe(false);
    expect(g(repo, 'status', '--porcelain')).toBe('');
  });
});
