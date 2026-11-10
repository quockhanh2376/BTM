import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTurn, syncWorkspace, workspacePath } from '../src/isolation/trusted.ts';
import type { Config } from '../src/config.ts';
import type { ExecFn } from '../src/isolation/worker.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// exec giả: bỏ tiền tố sudo … btm-worker-exec <cwd> -- và chạy lệnh trực tiếp (không sudo thật).
const direct: ExecFn = (file, args) => {
  const argv = file === 'sudo' ? args.slice(args.indexOf('--') + 1) : [file, ...args];
  return execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', stdio: 'pipe' });
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'btm-iso-'));
  roots.push(root);
  const projectsRoot = join(root, 'projects');
  const trustedRoot = join(root, 'trusted');
  mkdirSync(projectsRoot); mkdirSync(trustedRoot);
  const cfg = { host: { worker_user: 'btm-worker', projects_root: projectsRoot, trusted_root: trustedRoot } } as unknown as Config;
  const checkout = join(trustedRoot, 'demo');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
  writeFileSync(join(checkout, 'a.txt'), 'base\n');
  g(checkout, 'add', '.'); g(checkout, 'commit', '-qm', 'base');
  g(checkout, 'checkout', '-qb', 'goal/G1-x');
  const ws = workspacePath(cfg, checkout);
  return { cfg, checkout, ws, g };
}

describe('P4.5: syncWorkspace + importTurn (checkout tin cậy)', () => {
  it('sync tạo workspace lần đầu, đúng nhánh và sha của checkout; lượt sau ghi đè thay đổi của worker', () => {
    const c = setup();
    syncWorkspace(c.cfg, c.checkout, direct);
    expect(c.g(c.ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('goal/G1-x');
    expect(c.g(c.ws, 'rev-parse', 'HEAD')).toBe(c.g(c.checkout, 'rev-parse', 'HEAD'));
    writeFileSync(join(c.ws, 'a.txt'), 'worker\n');
    c.g(c.ws, 'commit', '-qam', 'rác');
    syncWorkspace(c.cfg, c.checkout, direct);
    expect(readFileSync(join(c.ws, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n');
  });

  it('import: commit của agent + thay đổi chưa commit về checkout y như agent chạy trực tiếp; không còn commit tạm', () => {
    const c = setup();
    syncWorkspace(c.cfg, c.checkout, direct);
    writeFileSync(join(c.ws, 'b.txt'), 'b\n');
    c.g(c.ws, 'add', 'b.txt'); c.g(c.ws, 'commit', '-qm', 'GTM-0001: b');
    writeFileSync(join(c.ws, 'a.txt'), 'changed\n');
    const res = importTurn(c.cfg, c.checkout, direct);
    expect(res).toEqual({ ok: true, changed: true });
    expect(c.g(c.checkout, 'log', '-1', '--format=%s')).toBe('GTM-0001: b');
    expect(readFileSync(join(c.checkout, 'a.txt'), 'utf8')).toBe('changed\n');
    expect(c.g(c.checkout, 'status', '--porcelain')).toContain('a.txt');
    expect(c.g(c.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('goal/G1-x');
  });

  it('agent sửa main, .git/config, tạo nhánh lạ trong workspace → checkout tin cậy không bị ảnh hưởng', () => {
    const c = setup();
    const mainBefore = c.g(c.checkout, 'rev-parse', 'main');
    const cfgBefore = readFileSync(join(c.checkout, '.git', 'config'), 'utf8');
    syncWorkspace(c.cfg, c.checkout, direct);
    c.g(c.ws, 'config', 'filter.x.clean', 'sh evil.sh');
    c.g(c.ws, 'branch', '-f', 'main', 'HEAD');
    c.g(c.ws, 'branch', 'evil');
    c.g(c.ws, 'checkout', '-q', 'evil');
    writeFileSync(join(c.ws, 'evil.txt'), 'x\n');
    c.g(c.ws, 'add', '.'); c.g(c.ws, 'commit', '-qm', 'evil');
    expect(importTurn(c.cfg, c.checkout, direct).ok).toBe(true);
    expect(c.g(c.checkout, 'rev-parse', 'main')).toBe(mainBefore);
    expect(readFileSync(join(c.checkout, '.git', 'config'), 'utf8')).toBe(cfgBefore);
    expect(() => c.g(c.checkout, 'rev-parse', '--verify', '-q', 'refs/heads/evil')).toThrow();
    expect(existsSync(join(c.checkout, 'evil.txt'))).toBe(false);
  });

  it('bundle rác → bundle_invalid, checkout không đổi', () => {
    const c = setup();
    syncWorkspace(c.cfg, c.checkout, direct);
    const head = c.g(c.checkout, 'rev-parse', 'HEAD');
    const garbage: ExecFn = (file, args) => {
      const argv = args.slice(args.indexOf('--') + 1);
      const i = argv.indexOf('create');
      if (argv.includes('bundle') && i > 0) { writeFileSync(argv[i + 1]!, 'not a bundle'); return ''; }
      return direct(file, args);
    };
    expect(importTurn(c.cfg, c.checkout, garbage)).toEqual({ ok: false, reason: 'bundle_invalid' });
    expect(c.g(c.checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(c.g(c.checkout, 'status', '--porcelain')).toBe('');
  });
});
