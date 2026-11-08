import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgv, type ArgvOpts } from '../src/runner/argv.ts';
import { runProcess } from '../src/runner/run.ts';

describe('Runner Argv', () => {
  const defaultOpts: ArgvOpts = {
    seat: 'dev',
    timeoutMin: 25,
    allow: ['cat', 'ls', 'npm test'],
    outFile: '/tmp/test.out',
  };

  describe('antigravity-cli', () => {
    it('never contains --dangerously-skip-permissions', () => {
      const argv = buildArgv('antigravity-cli', 'fix bug', defaultOpts);
      const cmdStr = argv.join(' ');
      expect(cmdStr).not.toContain('--dangerously-skip-permissions');
    });

    it('contains --sandbox and command(npm test) when allow has npm test', () => {
      const argv = buildArgv('antigravity-cli', 'fix bug', defaultOpts);
      expect(argv[0]).toBe('script');
      expect(argv[1]).toBe('-qec');
      expect(argv[3]).toBe('/dev/null');

      const cmd = argv[2];
      expect(cmd).toContain('--sandbox');
      expect(cmd).toContain('--mode accept-edits');
      expect(cmd).toContain('--print-timeout 25m');
      expect(cmd).toContain('command(npm test)');
      expect(cmd).toContain('command(cat)');
      expect(cmd).toContain('command(ls)');
    });

    it('quotes prompt with single quotes and Vietnamese correctly', async () => {
      const prompt = `Báo cáo: T-001 hoàn thành 100% 'đúng tiến độ' & "chất lượng", $HOME và \`test\``;
      const argv = buildArgv('antigravity-cli', prompt, defaultOpts);

      // Verify that replacing 'agy' with 'echo' in the script command outputs the exact prompt
      const cmdWithEcho = argv[2].replace(/^agy\s+-p\s+/, 'echo ');
      const tmpDir = mkdtempSync(join(tmpdir(), 'btm-argv-'));
      try {
        const res = await runProcess(['script', '-qec', cmdWithEcho, '/dev/null'], {
          cwd: tmpDir,
          timeoutMs: 5000,
          logFile: join(tmpDir, 'test.log'),
        });
        expect(res.output).toContain(prompt);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('codex-cli', () => {
    it('uses read-only sandbox for qc seat', () => {
      const argv = buildArgv('codex-cli', 'review task', {
        ...defaultOpts,
        seat: 'qc',
        outFile: '/tmp/qc.out',
      });
      expect(argv).toEqual([
        'codex',
        'exec',
        '--sandbox',
        'read-only',
        '-o',
        '/tmp/qc.out',
        'review task',
      ]);
    });

    it('uses workspace-write sandbox for dev seat', () => {
      const argv = buildArgv('codex-cli', 'implement task', {
        ...defaultOpts,
        seat: 'dev',
        outFile: '/tmp/dev.out',
      });
      expect(argv).toEqual([
        'codex',
        'exec',
        '--sandbox',
        'workspace-write',
        '-o',
        '/tmp/dev.out',
        'implement task',
      ]);
    });

    it('adds -i <image> for codex-cli when images are provided', () => {
      const argv = buildArgv('codex-cli', 'review task with image', {
        ...defaultOpts,
        seat: 'qc',
        outFile: '/tmp/qc.out',
        images: ['team/inbox/N-1.png', 'team/inbox/N-2.jpg'],
      });
      expect(argv).toEqual([
        'codex',
        'exec',
        '--sandbox',
        'read-only',
        '-o',
        '/tmp/qc.out',
        '-i',
        'team/inbox/N-1.png',
        '-i',
        'team/inbox/N-2.jpg',
        'review task with image',
      ]);
    });
  });

  describe('claude-code', () => {
    it('builds claude argv with allowedTools and permission mode', () => {
      const argv = buildArgv('claude-code', 'plan task', {
        ...defaultOpts,
        seat: 'pm',
        allow: ['cat', 'git status'],
      });
      expect(argv).toEqual([
        'claude',
        '-p',
        'plan task',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Bash(cat:*),Bash(git status:*)',
        'Read',
        'Edit',
        'Write',
      ]);
    });

    it('gives claude-code in qc seat only Read tool without acceptEdits, Edit, or Write', () => {
      const argv = buildArgv('claude-code', 'review task', {
        ...defaultOpts,
        seat: 'qc',
      });
      expect(argv).toEqual([
        'claude',
        '-p',
        'review task',
        '--allowedTools',
        'Read',
      ]);
    });
  });

  describe('unsupported tool', () => {
    it('throws on unknown tool', () => {
      expect(() =>
        buildArgv('unknown-tool' as any, 'prompt', defaultOpts)
      ).toThrow(/Unsupported tool/);
    });
  });
});
