import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo } from './helpers.ts';
import { openStore } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { publishGoal, readRelease, releaseTarget } from '../src/release/publish.ts';

function setup(opts: { github?: Record<string, string>; key?: boolean; version?: string } = {}) {
  const repo = tmpRepo({
    'team/project.yaml': 'key: GT\n',
    'package.json': JSON.stringify({ name: 'g', version: opts.version ?? '1.2.3' }),
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'btm-data-'));
  if (opts.key !== false) {
    mkdirSync(join(dataDir, 'keys'));
    writeFileSync(join(dataDir, 'keys', 'GT'), 'not-a-real-key');
    writeFileSync(join(dataDir, 'keys', 'known_hosts'), 'github.com ssh-ed25519 AAAA');
  }
  const base = loadConfig('btm.config.yaml');
  const cfg = { ...base, host: { ...base.host, data_dir: dataDir }, release: { require_audit: true, docs_ticket: true, github: opts.github ?? { GT: 'someone/GameTest-BTM' } } } as Config;
  const store = openStore(':memory:');
  const g = store.createGoal(repo, 'Shooter');
  store.setGoalState(repo, g.n, 'merged', 'owner', 'merged');
  return { repo, cfg, store, n: g.n };
}

describe('release publish (decision 0006)', () => {
  it('không có cấu hình github cho project thì không làm gì', async () => {
    const { repo, cfg, store, n } = setup({ github: {} });
    expect(releaseTarget(cfg, repo)).toBeNull();
    expect(await publishGoal(store, repo, cfg, n, async () => { throw new Error('must not push'); })).toBeNull();
  });

  it('thiếu deploy key thì báo deploy_key_missing, không push', async () => {
    const { repo, cfg, store, n } = setup({ key: false });
    const info = await publishGoal(store, repo, cfg, n, async () => { throw new Error('must not push'); });
    expect(info?.ok).toBe(false);
    expect(info?.error).toBe('deploy_key_missing');
  });

  it('gắn tag v<version> vào main rồi push main + tag bằng deploy key, không force', async () => {
    const { repo, cfg, store, n } = setup();
    const calls: string[][] = [];
    const info = await publishGoal(store, repo, cfg, n, async (_r, args) => { calls.push(args); return ''; });
    expect(info).toMatchObject({ ok: true, tag: 'v1.2.3', target: 'someone/GameTest-BTM', url: 'https://github.com/someone/GameTest-BTM/tree/v1.2.3' });
    const main = execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim();
    expect(execFileSync('git', ['rev-parse', 'v1.2.3^{commit}'], { cwd: repo }).toString().trim()).toBe(main);
    const args = calls[0]!;
    expect(args).toContain('git@github.com:someone/GameTest-BTM.git');
    expect(args).toContain('refs/heads/main:refs/heads/main');
    expect(args).toContain('refs/tags/v1.2.3:refs/tags/v1.2.3');
    expect(args.join(' ')).not.toMatch(/--force|\+refs/);
    expect(args.find((a) => a.startsWith('core.sshCommand='))).toMatch(/IdentitiesOnly=yes.*StrictHostKeyChecking=yes/);
    expect(readRelease(store, repo, n)?.ok).toBe(true);
  });

  it('push lỗi thì lưu lỗi ngắn để dashboard hiện Push lại; push lại dùng tag cũ', async () => {
    const { repo, cfg, store, n } = setup();
    const fail = await publishGoal(store, repo, cfg, n, async () => { throw Object.assign(new Error('x'), { stderr: 'remote: Permission denied\nfatal: Could not read from remote repository.' }); });
    expect(fail).toMatchObject({ ok: false, error: 'fatal: Could not read from remote repository.' });
    const again = await publishGoal(store, repo, cfg, n, async () => '');
    expect(again?.ok).toBe(true);
  });

  it('tag đã có ở commit khác thì không ghi đè', async () => {
    const { repo, cfg, store, n } = setup();
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', 'old'], { cwd: repo });
    execFileSync('git', ['tag', 'v1.2.3', 'HEAD~1'], { cwd: repo });
    const info = await publishGoal(store, repo, cfg, n, async () => { throw new Error('must not push'); });
    expect(info?.error).toBe('tag_exists:v1.2.3');
  });

  it('goal chưa merge thì không push', async () => {
    const { repo, cfg, store, n } = setup();
    store.setGoalState(repo, n, 'audit_passed', 'core', 'x');
    const info = await publishGoal(store, repo, cfg, n, async () => { throw new Error('must not push'); });
    expect(info?.error).toBe('goal_not_merged');
  });
});
