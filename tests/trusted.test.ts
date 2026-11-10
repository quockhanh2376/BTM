import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importGoalBundle, syncWorkspace, trustedRepoPath } from '../src/isolation/trusted.ts';
import type { Config } from '../src/config.ts';
import type { ExecFn } from '../src/isolation/worker.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'btm-trusted-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const trustedRoot = join(root, 'trusted');
  const config = { host: { trusted_root: trustedRoot } } as unknown as Config;
  const trusted = trustedRepoPath(config, workspace);
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const exec: ExecFn = (file, args) => {
    if (file === 'git') return execFileSync(file, args, { encoding: 'utf8', stdio: 'pipe' });
    throw new Error(`Unexpected command ${file}`);
  };
  execFileSync('git', ['init', '-b', 'main', workspace], { stdio: 'ignore' });
  run(workspace, 'config', 'user.name', 'test');
  run(workspace, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(workspace, 'file.txt'), 'base\n');
  run(workspace, 'add', '.'); run(workspace, 'commit', '-m', 'base');
  execFileSync('git', ['clone', '--bare', '--no-local', workspace, trusted], { stdio: 'ignore' });
  return { root, workspace, trusted, config, run, exec };
}

describe('trusted repo bundle import', () => {
  it('imports the one goal head at the incoming ref', () => {
    const c = setup();
    c.run(c.workspace, 'checkout', '-b', 'goal/G1-work');
    writeFileSync(join(c.workspace, 'file.txt'), 'goal\n');
    c.run(c.workspace, 'commit', '-am', 'goal');
    const expected = c.run(c.workspace, 'rev-parse', 'HEAD');
    expect(importGoalBundle(c.config, c.workspace, { n: 1, branch: 'goal/G1-work' }, c.exec)).toEqual({ ok: true, sha: expected });
    expect(c.run(c.trusted, 'rev-parse', 'refs/btm/incoming/G1')).toBe(expected);
  });

  it('nhánh lạ trong workspace không lọt vào bundle (chỉ đóng gói đúng nhánh goal)', () => {
    const c = setup();
    c.run(c.workspace, 'checkout', '-b', 'goal/G1-work');
    c.run(c.workspace, 'branch', 'extra');
    expect(importGoalBundle(c.config, c.workspace, { n: 1, branch: 'goal/G1-work' }, c.exec).ok).toBe(true);
    expect(() => c.run(c.trusted, 'rev-parse', '--verify', 'refs/heads/extra')).toThrow();
  });

  it('tên nhánh goal sai định dạng → bundle_wrong_ref, không chạy lệnh nào', () => {
    const c = setup();
    const calls: string[] = [];
    const spy: ExecFn = (f, a) => { calls.push(f); return ''; };
    expect(importGoalBundle(c.config, c.workspace, { n: 1, branch: 'main' }, spy)).toEqual({ ok: false, reason: 'bundle_wrong_ref' });
    expect(calls).toEqual([]);
  });

  it('rejects extra branch, replace, or tag refs without changing trusted refs', () => {
    const c = setup();
    c.run(c.workspace, 'checkout', '-b', 'goal/G1-work');
    c.run(c.workspace, 'branch', 'extra');
    c.run(c.workspace, 'update-ref', 'refs/replace/example', c.run(c.workspace, 'rev-parse', 'HEAD'));
    c.run(c.workspace, 'tag', 'extra-tag');
    const before = c.run(c.trusted, 'show-ref');
    const createAll: ExecFn = (file, args, options) => {
      const createIndex = args.indexOf('create');
      if (createIndex >= 0 && args[createIndex - 1] === 'bundle') {
        const rewritten = [...args.slice(0, createIndex + 2), '--all'];
        return execFileSync(file, rewritten, { encoding: 'buffer', stdio: options?.stdio ?? 'pipe' });
      }
      return execFileSync(file, args, { encoding: 'buffer', stdio: options?.stdio ?? 'pipe' });
    };
    expect(importGoalBundle(c.config, c.workspace, { n: 1, branch: 'goal/G1-work' }, createAll)).toEqual({ ok: false, reason: 'bundle_wrong_ref' });
    expect(c.run(c.trusted, 'show-ref')).toBe(before);
  });

  it('rejects malformed bundle and restores workspace main from trusted main', () => {
    const c = setup();
    // worker ghi rác thay cho bundle
    const garbage: ExecFn = (_f, args) => { writeFileSync(args[args.indexOf('create') + 1], 'not a bundle'); return ''; };
    const trustedSha = c.run(c.trusted, 'rev-parse', 'refs/heads/main');
    const before = c.run(c.trusted, 'show-ref');
    expect(importGoalBundle(c.config, c.workspace, { n: 1, branch: 'goal/G1-work' }, garbage)).toEqual({ ok: false, reason: 'bundle_invalid' });
    expect(c.run(c.trusted, 'show-ref')).toBe(before);
    c.run(c.workspace, 'checkout', '-b', 'main-changed');
    writeFileSync(join(c.workspace, 'file.txt'), 'changed\n');
    c.run(c.workspace, 'commit', '-am', 'changed');
    c.run(c.workspace, 'branch', '-f', 'main', 'HEAD');
    expect(trustedRepoPath(c.config, c.workspace)).toBe(c.trusted);
    syncWorkspace(c.config, c.workspace, 'main', trustedSha, c.exec);
    expect(c.run(c.workspace, 'rev-parse', 'main')).toBe(trustedSha);
    expect(c.run(c.workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });
});
