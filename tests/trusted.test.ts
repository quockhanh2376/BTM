import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTurn, readWorkerOut, syncWorkspace, workerOutFile, workspacePath } from '../src/isolation/trusted.ts';
import type { Config } from '../src/config.ts';
import type { ExecFn } from '../src/isolation/worker.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// exec giả: bỏ tiền tố sudo … btm-worker-exec <cwd> -- và chạy lệnh trực tiếp (không sudo thật); trả Buffer như execFileSync.
const direct: ExecFn = (file, args, o) => {
  const argv = file === 'sudo' ? args.slice(args.indexOf('--') + 1) : [file, ...args];
  return execFileSync(argv[0]!, argv.slice(1), { stdio: 'pipe', maxBuffer: o?.maxBuffer });
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'btm-iso-'));
  roots.push(root);
  const workRoot = join(root, 'work');
  const trustedRoot = join(root, 'trusted');
  mkdirSync(join(workRoot, 'btm-elon'), { recursive: true });
  mkdirSync(join(workRoot, 'btm-jenny'), { recursive: true });
  mkdirSync(trustedRoot);
  const cfg = { host: { worker_prefix: 'btm-', projects_root: join(root, 'projects'), trusted_root: trustedRoot, work_root: workRoot } } as unknown as Config;
  const checkout = join(trustedRoot, 'demo');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
  writeFileSync(join(checkout, 'a.txt'), 'base\n');
  g(checkout, 'add', '.'); g(checkout, 'commit', '-qm', 'base');
  g(checkout, 'checkout', '-qb', 'goal/G1-x');
  const ws = workspacePath(cfg, 'elon', checkout);
  return { cfg, checkout, ws, g };
}

describe('P4.5: syncWorkspace + importTurn (checkout tin cậy, workspace riêng từng agent)', () => {
  it('workspace riêng theo user của agent', () => {
    const c = setup();
    expect(c.ws).toBe(join(c.cfg.host.work_root!, 'btm-elon', 'demo'));
    expect(workspacePath(c.cfg, 'jenny', c.checkout)).toBe(join(c.cfg.host.work_root!, 'btm-jenny', 'demo'));
  });

  it('sync tạo workspace lần đầu, đúng nhánh và sha, có cả main; lượt sau ghi đè thay đổi của worker', () => {
    const c = setup();
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    expect(c.g(c.ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('goal/G1-x');
    expect(c.g(c.ws, 'rev-parse', 'HEAD')).toBe(c.g(c.checkout, 'rev-parse', 'HEAD'));
    expect(c.g(c.ws, 'rev-parse', 'main')).toBe(c.g(c.checkout, 'rev-parse', 'main'));
    writeFileSync(join(c.ws, 'a.txt'), 'worker\n');
    c.g(c.ws, 'commit', '-qam', 'rác');
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    expect(readFileSync(join(c.ws, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n');
  });

  it('sync dựng .git mới: config/ref do agent cài ở lượt trước không còn', () => {
    const c = setup();
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    c.g(c.ws, 'config', 'filter.x.clean', 'sh evil.sh');
    c.g(c.ws, 'update-ref', 'refs/replace/abc', 'HEAD');
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    expect(() => c.g(c.ws, 'config', '--get', 'filter.x.clean')).toThrow();
    expect(c.g(c.ws, 'for-each-ref', 'refs/replace')).toBe('');
  });

  it('import: commit của agent + thay đổi chưa commit về checkout y như agent chạy trực tiếp; không còn commit tạm', () => {
    const c = setup();
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    writeFileSync(join(c.ws, 'b.txt'), 'b\n');
    c.g(c.ws, 'add', 'b.txt'); c.g(c.ws, 'commit', '-qm', 'GTM-0001: b');
    writeFileSync(join(c.ws, 'a.txt'), 'changed\n');
    const res = importTurn(c.cfg, 'elon', c.checkout, direct);
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
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    c.g(c.ws, 'config', 'filter.x.clean', 'sh evil.sh');
    c.g(c.ws, 'branch', '-f', 'main', 'HEAD');
    c.g(c.ws, 'branch', 'evil');
    c.g(c.ws, 'checkout', '-q', 'evil');
    writeFileSync(join(c.ws, 'evil.txt'), 'x\n');
    c.g(c.ws, 'add', '.'); c.g(c.ws, 'commit', '-qm', 'evil');
    expect(importTurn(c.cfg, 'elon', c.checkout, direct).ok).toBe(true);
    expect(c.g(c.checkout, 'rev-parse', 'main')).toBe(mainBefore);
    expect(readFileSync(join(c.checkout, '.git', 'config'), 'utf8')).toBe(cfgBefore);
    expect(() => c.g(c.checkout, 'rev-parse', '--verify', '-q', 'refs/heads/evil')).toThrow();
    expect(existsSync(join(c.checkout, 'evil.txt'))).toBe(false);
  });

  it('commit có symlink hoặc submodule → bundle_unsafe, checkout giữ nguyên, không còn ref incoming', () => {
    for (const mode of ['120000', '160000']) {
      const c = setup();
      syncWorkspace(c.cfg, 'elon', c.checkout, direct);
      const head = c.g(c.checkout, 'rev-parse', 'HEAD');
      const target = mode === '120000'
        ? execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: c.ws, input: 'a.txt', encoding: 'utf8' }).trim()
        : head;
      c.g(c.ws, 'update-index', '--add', '--cacheinfo', `${mode},${target},link`);
      c.g(c.ws, 'commit', '-qm', 'GTM-0001: link');
      // working tree phải có entry, nếu không `add -A` của import sẽ ghi nhận xoá nó
      if (mode === '120000') c.g(c.ws, 'checkout', '--', 'link');
      else mkdirSync(join(c.ws, 'link'));
      expect(importTurn(c.cfg, 'elon', c.checkout, direct)).toEqual({ ok: false, reason: 'bundle_unsafe' });
      expect(c.g(c.checkout, 'rev-parse', 'HEAD')).toBe(head);
      expect(c.g(c.checkout, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('goal/G1-x');
      expect(c.g(c.checkout, 'for-each-ref', 'refs/btm')).toBe('');
    }
  });

  it('bundle rác → bundle_invalid, checkout không đổi', () => {
    const c = setup();
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    const head = c.g(c.checkout, 'rev-parse', 'HEAD');
    const garbage: ExecFn = (file, args, o) => (args.includes('bundle') ? Buffer.from('not a bundle') : direct(file, args, o));
    expect(importTurn(c.cfg, 'elon', c.checkout, garbage)).toEqual({ ok: false, reason: 'bundle_invalid' });
    expect(c.g(c.checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(c.g(c.checkout, 'status', '--porcelain')).toBe('');
  });

  it('file kết quả CLI: đọc qua worker; sync xoá kết quả cũ', () => {
    const c = setup();
    writeFileSync(workerOutFile(c.cfg, 'elon'), 'xong');
    expect(readWorkerOut(c.cfg, 'elon', direct)).toBe('xong');
    syncWorkspace(c.cfg, 'elon', c.checkout, direct);
    expect(readWorkerOut(c.cfg, 'elon', direct)).toBe('');
  });
});
