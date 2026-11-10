import { describe, expect, it, vi } from 'vitest';
import { HostSchema } from '../src/config.ts';
import { workerKillAll, workerReset, workerUser, wrapForWorker } from '../src/isolation/worker.ts';

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
    expect(wrapForWorker({ ...baseConfig, host: { ...baseConfig.host, worker_prefix: 'btm-' } } as any, 'elon', argv, '/repo')).toEqual([
      'sudo', '-n', '-u', 'btm-elon', '/usr/local/bin/btm-worker-exec', '/repo', '--', ...argv,
    ]);
    expect(wrapForWorker(baseConfig as any, 'elon', argv, '/repo')).toBe(argv);
    // mỗi agent một user riêng; tên user lạ (agent id có ký tự xấu) → từ chối
    expect(workerUser({ host: { worker_prefix: 'btm-' } } as any, 'jenny')).toBe('btm-jenny');
    expect(() => workerUser({ host: { worker_prefix: 'btm-' } } as any, 'x;rm')).toThrow('invalid worker user');
  });

  it('runs worker killall through the injectable executor only when configured', () => {
    const exec = vi.fn();
    workerKillAll({ ...baseConfig, host: { ...baseConfig.host, worker_prefix: 'btm-' } } as any, 'jacky', exec);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][1]).toEqual(['-n', '-u', 'btm-jacky', '/usr/local/bin/btm-worker-killall']);
    exec.mockClear();
    workerKillAll(baseConfig as any, 'jacky', exec);
    expect(exec).not.toHaveBeenCalled();
  });

  it('validates worker_prefix syntax and absolute trusted_root/work_root', () => {
    const valid = { ...baseConfig, host: { ...baseConfig.host, worker_prefix: 'btm-', trusted_root: '/srv/trusted', work_root: '/srv/btm-work' } };
    expect(HostSchema.safeParse(valid.host).success).toBe(true);
    expect(HostSchema.safeParse({ ...baseConfig.host, worker_prefix: 'Bad User' }).success).toBe(false);
    expect(HostSchema.safeParse({ ...baseConfig.host, trusted_root: 'relative/path' }).success).toBe(false);
    expect(HostSchema.safeParse({ ...baseConfig.host, work_root: 'relative/path' }).success).toBe(false);
  });
});

describe('workerKillAll – mã thoát', () => {
  it('pkill không còn tiến trình (exit 1) → không ném lỗi; lỗi khác → ném', async () => {
    const { workerKillAll } = await import('../src/isolation/worker.ts');
    const cfg = { host: { worker_prefix: 'btm-' } } as any;
    expect(() => workerKillAll(cfg, 'elon', () => { throw Object.assign(new Error('none'), { status: 1 }); })).not.toThrow();
    expect(() => workerKillAll(cfg, 'elon', () => { throw Object.assign(new Error('sudo broken'), { status: 2 }); })).toThrow('sudo broken');
  });
});

describe('P5-T8: workerReset', () => {
  it('gọi btm-worker-reset dưới user của agent; không cách ly → không làm gì', () => {
    const exec = vi.fn();
    workerReset({ host: { worker_prefix: 'btm-' } } as any, 'jenny', exec);
    expect(exec.mock.calls[0]![1]).toEqual(['-n', '-u', 'btm-jenny', '/usr/local/bin/btm-worker-reset']);
    exec.mockClear();
    workerReset({ host: {} } as any, 'jenny', exec);
    expect(exec).not.toHaveBeenCalled();
  });
});
