import { describe, expect, it, vi } from 'vitest';
import { HostSchema } from '../src/config.ts';
import { workerKillAll, wrapForWorker } from '../src/isolation/worker.ts';

const baseConfig = {
  host: {
    run_as_user: 'zon',
    projects_root: '/srv/projects',
    dashboard: { bind: '127.0.0.1', port: 3000 },
    data_dir: '/srv/btm',
  },
  agents: { claude: { tool: 'claude', model: 'x', can_sit: ['dev'] } },
  seats: { pm: 'claude', dev: 'claude', qc: 'claude' },
  turn: { timeout_minutes: { pm: 1, dev: 1, qc: 1 } },
  runner: { agy_allow_commands: [] },
};

describe('worker isolation', () => {
  it('wraps commands for the configured worker and leaves commands unchanged without one', () => {
    const argv = ['claude', '-p', 'hello'];
    expect(wrapForWorker({ ...baseConfig, host: { ...baseConfig.host, worker_user: 'btm-worker' } } as any, argv, '/repo')).toEqual([
      'sudo', '-n', '-u', 'btm-worker', '/usr/local/bin/btm-worker-exec', '/repo', '--', ...argv,
    ]);
    expect(wrapForWorker(baseConfig as any, argv, '/repo')).toBe(argv);
  });

  it('runs worker killall through the injectable executor only when configured', () => {
    const exec = vi.fn();
    workerKillAll({ ...baseConfig, host: { ...baseConfig.host, worker_user: 'btm-worker' } } as any, exec);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][1]).toContain('/usr/local/bin/btm-worker-killall');
    exec.mockClear();
    workerKillAll(baseConfig as any, exec);
    expect(exec).not.toHaveBeenCalled();
  });

  it('validates worker_user syntax and absolute trusted_root', () => {
    const valid = { ...baseConfig, host: { ...baseConfig.host, worker_user: 'btm-worker', trusted_root: '/srv/trusted' } };
    expect(HostSchema.safeParse(valid.host).success).toBe(true);
    expect(HostSchema.safeParse({ ...baseConfig.host, worker_user: 'Bad User' }).success).toBe(false);
    expect(HostSchema.safeParse({ ...baseConfig.host, trusted_root: 'relative/path' }).success).toBe(false);
  });
});

describe('workerKillAll – mã thoát', () => {
  it('pkill không còn tiến trình (exit 1) → không ném lỗi; lỗi khác → ném', async () => {
    const { workerKillAll } = await import('../src/isolation/worker.ts');
    const cfg = { host: { worker_user: 'btm-worker' } } as any;
    expect(() => workerKillAll(cfg, () => { throw Object.assign(new Error('none'), { status: 1 }); })).not.toThrow();
    expect(() => workerKillAll(cfg, () => { throw Object.assign(new Error('sudo broken'), { status: 2 }); })).toThrow('sudo broken');
  });
});
