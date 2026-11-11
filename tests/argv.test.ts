import { describe, it, expect } from 'vitest';
import { agentEffort, agentModel } from '../src/agents/model.ts';
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
        '--',
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
        '--',
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
        '--',
        'review task with image',
      ]);
    });

    it('always places -- right before prompt (with and without images)', () => {
      const prompt = 'review task';
      const withoutImages = buildArgv('codex-cli', prompt, defaultOpts);
      expect(withoutImages[withoutImages.length - 1]).toBe(prompt);
      expect(withoutImages[withoutImages.length - 2]).toBe('--');

      const withImages = buildArgv('codex-cli', prompt, {
        ...defaultOpts,
        images: ['team/inbox/N-1.png', 'team/inbox/N-2.jpg'],
      });
      expect(withImages[withImages.length - 1]).toBe(prompt);
      expect(withImages[withImages.length - 2]).toBe('--');
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

describe('P5-T2: model + effort', () => {
  const base = { seat: 'dev' as const, timeoutMin: 5, allow: ['npm test'], outFile: '/tmp/o' };
  it('claude: --model/--effort trước -p; không model → chỉ effort', () => {
    expect(buildArgv('claude-code', 'x', { ...base, model: 'opus', effort: 'high' }).slice(0, 6)).toEqual(['claude', '--model', 'opus', '--effort', 'high', '-p']);
    expect(buildArgv('claude-code', 'x', { ...base, seat: 'qc', effort: 'medium' })).toEqual(['claude', '--effort', 'medium', '-p', 'x', '--allowedTools', 'Read']);
  });
  it('codex: -m + model_reasoning_effort (Codex 0.167 có cả xhigh/max)', () => {
    const a = buildArgv('codex-cli', 'x', { ...base, model: 'gpt-6-luna', effort: 'max' });
    expect(a.slice(0, 6)).toEqual(['codex', 'exec', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="max"']);
    expect(buildArgv('codex-cli', 'x', { ...base, effort: 'low' })).not.toContain('-m');
  });
  it('agy: --model/--effort trong chuỗi lệnh', () => {
    const cmd = buildArgv('antigravity-cli', 'x', { ...base, model: 'gemini-3.8-flash-medium', effort: 'xhigh' })[2]!;
    expect(cmd).toContain(" --model 'gemini-3.8-flash-medium' --effort 'xhigh'");
    expect(buildArgv('antigravity-cli', 'x', base)[2]).not.toContain('--model');
  });
});

describe('P5-T2: agentModel/agentEffort', () => {
  const cfg = { agents: { elon: { tool: 'claude-code', command: 'claude', can_sit: ['pm'], model: 'opus' }, jenny: { tool: 'codex-cli', command: 'codex', can_sit: ['qc'] } } } as any;
  const store = (m: Record<string, string>) => ({ getSetting: (k: string) => (k in m ? m[k]! : null) });
  it('setting dashboard ghi đè config; giá trị lạ bị bỏ qua; mặc định medium', () => {
    expect(agentModel(cfg, null, 'elon')).toBe('opus');
    expect(agentModel(cfg, store({ 'agent_model:elon': 'sonnet' }), 'elon')).toBe('sonnet');
    expect(agentModel(cfg, store({ 'agent_model:elon': '' }), 'elon')).toBeUndefined();
    expect(agentModel(cfg, store({ 'agent_model:elon': 'x;rm' }), 'elon')).toBe('opus');
    expect(agentEffort(cfg, null, 'jenny')).toBe('medium');
    expect(agentEffort(cfg, store({ 'agent_effort:jenny': 'high' }), 'jenny')).toBe('high');
    expect(agentEffort(cfg, store({ 'agent_effort:jenny': 'ultra' }), 'jenny')).toBe('medium');
  });
});
