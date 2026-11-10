import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRepo } from './helpers.ts';
import { git, headSha, commitAll, changedFiles } from '../src/git.ts';
import { runGate, outsideScope, commitsMissingTicketId, reportHeaderOk } from '../src/gate/gate.ts';
import type { Ticket } from '../src/ticket/ticket.ts';

const TEST_AUTHOR = ['-c', 'user.name=test', '-c', 'user.email=test@btm.local'];

function makeCard(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'GTM-0001',
    goal: 'G1',
    number: 1,
    of: 1,
    title: 'Test ticket',
    type: 'feat',
    size: 'S',
    scope: ['src/'],
    acceptance: ['Pass test'],
    done_when: 'All green',
    depends_on: [],
    from_audit: false,
    ...overrides,
  };
}

describe('git helpers', () => {
  it('executes git command without trimming output', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    const branch = git(repo, 'branch', '--show-current');
    expect(branch).toBe('main\n');
  });

  it('throws on failed git command', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    expect(() => git(repo, 'log', 'non-existent-ref')).toThrow();
  });

  it('headSha returns current commit SHA', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    const sha = headSha(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(sha).toBe(expected);
  });

  it('commitAll returns null if working directory is clean', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    const result = commitAll(repo, 'clean commit', { name: 'jacky', email: 'jacky@btm.local' });
    expect(result).toBeNull();
  });

  it('commitAll commits changes and sets author', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    writeFileSync(join(repo, 'a.txt'), 'updated');
    writeFileSync(join(repo, 'new.txt'), 'new file');

    const newSha = commitAll(repo, 'feat: update a', { name: 'jacky', email: 'jacky@btm.local' });
    expect(newSha).toMatch(/^[0-9a-f]{40}$/);
    expect(headSha(repo)).toBe(newSha);

    const authorLog = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(authorLog).toBe('jacky <jacky@btm.local>');

    const commitMsg = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(commitMsg).toBe('feat: update a');
  });

  it('B3: repo có .git/hooks/post-commit sửa main → commitAll của BTM không chạy hook, main không đổi', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    const mainHeadBefore = headSha(repo);

    // Tạo nhánh goal/G1-test và checkout sang nhánh này
    git(repo, 'checkout', '-b', 'goal/G1-test');

    // Tạo .git/hooks/post-commit can thiệp sửa main
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hookScript = `#!/bin/sh\ngit update-ref refs/heads/main HEAD\n`;
    writeFileSync(join(hooksDir, 'post-commit'), hookScript, { mode: 0o777 });
    writeFileSync(join(hooksDir, 'post-commit.bat'), `@echo off\ngit update-ref refs/heads/main HEAD\n`);

    // Tạo thay đổi trên nhánh goal
    writeFileSync(join(repo, 'a.txt'), 'updated on goal');
    commitAll(repo, 'G1: update a', { name: 'core', email: 'core@btm.local' });

    // mainHead phải không bị hook sửa đổi
    const mainHeadAfter = git(repo, 'rev-parse', 'refs/heads/main').trim();
    expect(mainHeadAfter).toBe(mainHeadBefore);
  });

  it('commitAll overrides external GIT_AUTHOR_* and GIT_COMMITTER_* env vars', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    writeFileSync(join(repo, 'a.txt'), 'updated');

    const originalAuthorName = process.env.GIT_AUTHOR_NAME;
    const originalAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    const originalCommitterName = process.env.GIT_COMMITTER_NAME;
    const originalCommitterEmail = process.env.GIT_COMMITTER_EMAIL;

    try {
      process.env.GIT_AUTHOR_NAME = 'Different Author';
      process.env.GIT_AUTHOR_EMAIL = 'different@btm.local';
      process.env.GIT_COMMITTER_NAME = 'Different Committer';
      process.env.GIT_COMMITTER_EMAIL = 'diffcommitter@btm.local';

      const newSha = commitAll(repo, 'feat: override env', { name: 'jacky', email: 'jacky@btm.local' });
      expect(newSha).toMatch(/^[0-9a-f]{40}$/);

      const authorLog = execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(authorLog).toBe('jacky <jacky@btm.local>');

      const committerLog = execFileSync('git', ['log', '-1', '--format=%cn <%ce>'], { cwd: repo, encoding: 'utf8' }).trim();
      expect(committerLog).toBe('jacky <jacky@btm.local>');
    } finally {
      if (originalAuthorName !== undefined) process.env.GIT_AUTHOR_NAME = originalAuthorName;
      else delete process.env.GIT_AUTHOR_NAME;

      if (originalAuthorEmail !== undefined) process.env.GIT_AUTHOR_EMAIL = originalAuthorEmail;
      else delete process.env.GIT_AUTHOR_EMAIL;

      if (originalCommitterName !== undefined) process.env.GIT_COMMITTER_NAME = originalCommitterName;
      else delete process.env.GIT_COMMITTER_NAME;

      if (originalCommitterEmail !== undefined) process.env.GIT_COMMITTER_EMAIL = originalCommitterEmail;
      else delete process.env.GIT_COMMITTER_EMAIL;
    }
  });

  it('changedFiles returns added, modified, deleted, and renamed files', () => {
    const repo = tmpRepo({
      'src/keep.txt': 'keep',
      'src/delete.txt': 'delete',
      'src/rename_old.txt': 'rename',
    });
    const base = headSha(repo);

    // Modify
    writeFileSync(join(repo, 'src/keep.txt'), 'keep modified');
    // Delete via execFileSync git
    unlinkSync(join(repo, 'src/delete.txt'));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    // Rename via execFileSync git
    execFileSync('git', ['mv', 'src/rename_old.txt', 'src/rename_new.txt'], { cwd: repo });
    // Add new
    writeFileSync(join(repo, 'src/new.txt'), 'new file');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'step2'], { cwd: repo });

    const changed = changedFiles(repo, base);
    expect(changed).toContain('src/keep.txt');
    expect(changed).toContain('src/delete.txt');
    expect(changed).toContain('src/rename_old.txt');
    expect(changed).toContain('src/rename_new.txt');
    expect(changed).toContain('src/new.txt');
  });

  it('changedFiles returns empty array if no diff', () => {
    const repo = tmpRepo({ 'a.txt': 'hello' });
    const base = headSha(repo);
    expect(changedFiles(repo, base)).toEqual([]);
  });

  it('changedFiles handles Unicode filenames like src/é.ts', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    const base = headSha(repo);

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/é.ts'), 'export const e = 1;');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'add unicode file'], { cwd: repo });

    const changed = changedFiles(repo, base);
    expect(changed).toContain('src/é.ts');
  });

  it('changedFiles preserves trailing whitespace in filename', () => {
    const repo = tmpRepo({ 'a.txt': 'initial' });
    const base = headSha(repo);

    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/space '), 'trailing space');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'add space file'], { cwd: repo });

    const changed = changedFiles(repo, base);
    expect(changed).toContain('src/space ');
  });
});

describe('outsideScope', () => {
  it('returns empty array when all files match scope', () => {
    const changed = ['src/a.ts', 'src/sub/b.ts', 'README.md'];
    const scope = ['src/', 'README.md'];
    expect(outsideScope(changed, scope)).toEqual([]);
  });

  it('returns files not matching scope', () => {
    const changed = ['src/a.ts', 'other.ts', 'docs/spec.md'];
    const scope = ['src/'];
    expect(outsideScope(changed, scope)).toEqual(['other.ts', 'docs/spec.md']);
  });

  it('supports exact file matching without trailing slash', () => {
    const changed = ['src/a.ts', 'src/a.ts.bak', 'src/b.ts'];
    const scope = ['src/a.ts'];
    expect(outsideScope(changed, scope)).toEqual(['src/a.ts.bak', 'src/b.ts']);
  });

  it('scope without trailing slash is exact file and does not match nested paths', () => {
    const changed = ['src/a.ts', 'src/a.ts/x', 'src/a.ts.bak'];
    const scope = ['src/a.ts'];
    expect(outsideScope(changed, scope)).toEqual(['src/a.ts/x', 'src/a.ts.bak']);
  });
});

describe('runGate', () => {
  const emptyCmds = { build: '', lint: '', test: '' };
  const validReportHeader = 'GTM-0001 · G1#1/1 · Jacky-Dev\n';

  it('empty diff fails with empty_diff', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
      'team/reports/GTM-0001-dev.md': validReportHeader + 'OK\n',
    });
    const base = headSha(repo);
    const card = makeCard();

    const result = runGate(repo, card, base, emptyCmds);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('empty_diff');
  });

  it('changes only in team/reports/ still count as empty_diff', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);
    const card = makeCard();

    // Dev only adds report file, no changes to product files
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: only add report'], { cwd: repo });

    const result = runGate(repo, card, base, emptyCmds);
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('empty_diff');
  });

  it('delete outside scope fails with out_of_scope:<file>', () => {
    const repo = tmpRepo({
      'README.md': '# Intro',
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    unlinkSync(join(repo, 'README.md'));
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: delete readme'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('out_of_scope:README.md');
  });

  it('rename into scope still flags old path', () => {
    const repo = tmpRepo({
      'other.ts': 'export const other = 1;',
    });
    const base = headSha(repo);

    mkdirSync(join(repo, 'src'), { recursive: true });
    execFileSync('git', ['mv', 'other.ts', 'src/a.ts'], { cwd: repo });
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: move other into src'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('out_of_scope:other.ts');
  });

  it('dir scope allows nested files', () => {
    const repo = tmpRepo({
      'tests/auth/x.test.ts': 'test 1',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'tests/auth/x.test.ts'), 'test 2');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update test'], { cwd: repo });

    const card = makeCard({ scope: ['tests/auth/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('missing report fails with missing_report', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a without report'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('missing_report');
  });

  it('empty report fails with bad_report when require_report_schema is active', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), '   \n\n  ');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: empty report'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('bad_report');
  });

  it('report without OK or valid heading fails with bad_report', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + '# Summary\nEverything done.');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: bad report schema'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('bad_report');
  });

  it('report with ## Bug / ## Cần sửa / ## Cần xác nhận passes schema check', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(
      join(repo, 'team/reports/GTM-0001-dev.md'),
      validReportHeader + '## Bug\n- Phát hiện bug nhỏ ở controller\n## Cần sửa\n- Cần refactor helper'
    );

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: report with issues'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.reasons).not.toContain('bad_report');
    expect(result.ok).toBe(true);
  });

  it('allows disabling require_report_schema via option', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), 'arbitrary non-conforming content');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'skip schema report'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds, { require_report_schema: false });

    expect(result.reasons).not.toContain('bad_report');
    expect(result.ok).toBe(true);
  });

  it('always allows files in team/reports/', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');
    writeFileSync(join(repo, 'team/reports/extra.txt'), 'extra notes');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a and reports'], { cwd: repo });

    const card = makeCard({ scope: ['src/a.ts'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.reasons).not.toContain('out_of_scope:team/reports/GTM-0001-dev.md');
    expect(result.reasons).not.toContain('out_of_scope:team/reports/extra.txt');
    expect(result.ok).toBe(true);
  });

  it('fails with cmd_failed:<name> when commands fail', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, {
      build: 'exit 1',
      lint: 'exit 2',
      test: 'exit 3',
    });

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('cmd_failed:build');
    expect(result.reasons).toContain('cmd_failed:lint');
    expect(result.reasons).toContain('cmd_failed:test');
  });

  it('fails with cmd_timeout:<name> when command exceeds timeoutMs', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(
      repo,
      card,
      base,
      {
        build: 'sleep 1',
        lint: '',
        test: '',
      },
      50 // 50ms timeout
    );

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('cmd_timeout:build');
    expect(result.reasons).not.toContain('cmd_failed:build');
  });

  it('all good passes with ok true and empty reasons', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a and report'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, {
      build: 'echo build ok',
      lint: '',
      test: 'echo test ok',
    });

    expect(result).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it('fails with report_too_long when dev report has more than 5 non-empty lines', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    // 6 non-empty lines
    writeFileSync(
      join(repo, 'team/reports/GTM-0001-dev.md'),
      validReportHeader + ['## Bug', 'Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5'].join('\n')
    );

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a and report'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('report_too_long');
  });

  it('passes when dev report has 5 non-empty lines', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    // Exactly 5 non-empty lines with empty lines interspersed
    writeFileSync(
      join(repo, 'team/reports/GTM-0001-dev.md'),
      validReportHeader + ['## Bug', '', 'Line 1', '', 'Line 2', 'Line 3', 'Line 4'].join('\n')
    );

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a and report'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.reasons).not.toContain('report_too_long');
    expect(result.ok).toBe(true);
  });

  it('fails with commit_missing_ticket_id when commit subject misses ticket id', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), validReportHeader + 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'WIP: no ticket id'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('commit_missing_ticket_id');
  });

  it('fails with report_header_invalid when dev report does not start with ticket header', () => {
    const repo = tmpRepo({
      'src/a.ts': 'export const a = 1;',
    });
    const base = headSha(repo);

    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2;');
    mkdirSync(join(repo, 'team/reports'), { recursive: true });
    writeFileSync(join(repo, 'team/reports/GTM-0001-dev.md'), 'OK\n');

    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: update a and report'], { cwd: repo });

    const card = makeCard({ scope: ['src/'] });
    const result = runGate(repo, card, base, emptyCmds);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('report_header_invalid');
  });

  describe('Plan 4 Task 4: commitsMissingTicketId & reportHeaderOk', () => {
    it('commitsMissingTicketId: nhận diện commit đúng hoặc thiếu ticket id', () => {
      const repo = tmpRepo({ 'src/a.ts': 'v1' });
      const base = headSha(repo);

      // 1. Commit với đúng Ticket ID
      writeFileSync(join(repo, 'src/a.ts'), 'v2');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0012: add login form'], { cwd: repo });

      expect(commitsMissingTicketId(repo, base, 'GTM-0012')).toEqual([]);

      // 2. Thêm commit không bắt đầu bằng ID (WIP x)
      writeFileSync(join(repo, 'src/a.ts'), 'v3');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'WIP x'], { cwd: repo });
      const wipSha = headSha(repo);

      const missing1 = commitsMissingTicketId(repo, base, 'GTM-0012');
      expect(missing1).toEqual([wipSha]);

      // 3. Commit với ID khác (GTM-00123: x)
      writeFileSync(join(repo, 'src/a.ts'), 'v4');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-00123: another id'], { cwd: repo });
      const otherIdSha = headSha(repo);

      const missing2 = commitsMissingTicketId(repo, base, 'GTM-0012');
      expect(missing2).toEqual([otherIdSha, wipSha]);
    });

    it('reportHeaderOk: kiểm tra dòng đầu báo cáo theo chuẩn ticket', () => {
      const repo = tmpRepo({ 'src/a.ts': 'v1' });
      const ticket: Ticket = {
        id: 'GTM-0012',
        goal: 'G1',
        number: 3,
        of: 9,
        title: 'Reset password form',
        type: 'feat',
        size: 'M',
        scope: ['src/a.ts'],
        acceptance: ['ok'],
        done_when: 'ok',
        depends_on: [],
        from_audit: false,
      };

      mkdirSync(join(repo, 'team', 'reports'), { recursive: true });
      const reportPath = join(repo, 'team', 'reports', 'GTM-0012-dev.md');

      // 1. Dòng đầu đúng header → true
      writeFileSync(reportPath, 'GTM-0012 · G1#3/9 · Jacky-Dev\nOK\n');
      expect(reportHeaderOk(repo, ticket)).toBe(true);

      // 2. Dòng đầu chỉ là "OK" (thiếu header) → false
      writeFileSync(reportPath, 'OK\n');
      expect(reportHeaderOk(repo, ticket)).toBe(false);

      // 3. Dòng trống đầu file rồi header → true
      writeFileSync(reportPath, '\n  \n\nGTM-0012 · G1#3/9 · Jacky-Dev\nOK\n');
      expect(reportHeaderOk(repo, ticket)).toBe(true);

      // 4. Header với agent name khác (Jenny-Dev) → true (bỏ qua tên agent)
      writeFileSync(reportPath, 'GTM-0012 · G1#3/9 · Jenny-Dev\nOK\n');
      expect(reportHeaderOk(repo, ticket)).toBe(true);

      // 5. Header với sai số thứ tự hoặc goal → false
      writeFileSync(reportPath, 'GTM-0012 · G1#4/9 · Jacky-Dev\nOK\n');
      expect(reportHeaderOk(repo, ticket)).toBe(false);

      // 6. Thiếu file báo cáo → false
      unlinkSync(reportPath);
      expect(reportHeaderOk(repo, ticket)).toBe(false);
    });

    it('runGate: thay đổi trong team/tickets/ → ticket_tampered (kể cả khi scope có liệt kê)', () => {
      const repo = tmpRepo({
        'src/a.ts': 'v1',
        'team/tickets/GTM-0001.md': 'original ticket content\n',
      });
      const base = headSha(repo);
      mkdirSync(join(repo, 'team', 'reports'), { recursive: true });
      writeFileSync(join(repo, 'team', 'reports', 'GTM-0001-dev.md'), 'GTM-0001 · G1#1/1 · Jacky-Dev\nOK\n');

      // Dev modifies team/tickets/GTM-0001.md and src/a.ts
      writeFileSync(join(repo, 'src/a.ts'), 'v2');
      writeFileSync(join(repo, 'team/tickets/GTM-0001.md'), 'tampered content\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', [...TEST_AUTHOR, 'commit', '-m', 'GTM-0001: dev commit'], { cwd: repo });

      // Scope intentionally includes team/tickets/
      const ticket = makeCard({
        scope: ['src/a.ts', 'team/tickets/GTM-0001.md'],
      });

      const res = runGate(repo, ticket, base, { build: '', lint: '', test: '' });
      expect(res.ok).toBe(false);
      expect(res.reasons).toContain('ticket_tampered');
    });
  });
});

describe('P4.5-T2: gate dưới worker', () => {
  it('cách ly → lệnh gate chạy dưới user của Dev; killAll mỗi lệnh; đồng bộ 1 lần; thiếu agent → gate_sync_failed', () => {
    const repo = tmpRepo({ 'src/a.ts': 'export const a = 1;' });
    const base = headSha(repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;');
    commitAll(repo, 'GTM-0001: x', { name: 'd', email: 'd@x' });
    const killed: string[] = [];
    const synced: string[] = [];
    const cfg = { host: { worker_prefix: 'btm-', projects_root: '/srv/agent-projects', work_root: '/srv/btm-work' } } as any;
    runGate(repo, makeCard(), base, { build: 'true', lint: '', test: 'true' } as any, {
      cfg, agentId: 'jacky', killAll: (_c, a) => killed.push(a), sync: (_c, a, k) => synced.push(`${a}:${k}`),
      reset: (_c, a) => synced.push(`reset:${a}`),
    });
    expect(killed).toEqual(['jacky', 'jacky', 'jacky']); // trước sync + sau mỗi lệnh
    expect(synced).toEqual(['reset:jacky', `jacky:${repo}`]); // dọn cấu hình agent rồi đồng bộ 1 lần trước các lệnh
    const res = runGate(repo, makeCard(), base, { build: 'true', lint: '', test: '' } as any, { cfg, killAll: () => {}, sync: () => {}, reset: () => {} });
    expect(res.reasons).toContain('gate_sync_failed');
  });

});

describe('P5 review: team/project.yaml', () => {
  it('Dev sửa team/project.yaml (đổi ghế) → project_config_tampered dù scope có liệt kê', () => {
    const repo = tmpRepo({ 'src/a.ts': 'export const a = 1;', 'team/project.yaml': 'key: GTM\n' });
    const base = headSha(repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;');
    writeFileSync(join(repo, 'team', 'project.yaml'), 'key: GTM\nseats:\n  qc: jacky\n');
    commitAll(repo, 'GTM-0001: x', { name: 'd', email: 'd@x' });
    const card = { ...makeCard(), scope: ['src/', 'team/project.yaml'] };
    const res = runGate(repo, card as any, base, { build: '', lint: '', test: '' });
    expect(res.reasons).toContain('project_config_tampered');
  });
});
