import { describe, it, expect } from 'vitest';
import { createSystemReader, parseMemAvailable, parseNetDev, type SystemDeps } from '../src/server/system.ts';

const NET = (rx: number, tx: number) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0
  eth0: ${rx} 100 0 0 0 0 0 0 ${tx} 90 0 0 0 0 0 0
`;

function deps(over: Partial<SystemDeps> = {}): SystemDeps & { tick: (cpuBusy: number, cpuIdle: number, rx: number, tx: number, at: number) => void } {
  let busy = 0;
  let idle = 0;
  let net = NET(1000, 500);
  let at = 0;
  const d: any = {
    cpus: () => [{ model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }],
    totalmem: () => 1000,
    freemem: () => 250,
    statfs: () => ({ blocks: 100, bfree: 40, bavail: 30 }),
    readText: (p: string) => (p === '/proc/net/dev' ? net : null),
    now: () => at,
    ...over,
  };
  d.tick = (b: number, i: number, rx: number, tx: number, t: number) => { busy = b; idle = i; net = NET(rx, tx); at = t; };
  return d;
}

describe('Plan 9 Task 2: System status', () => {
  it('parseNetDev bỏ lo, cộng các card còn lại; parseMemAvailable đọc MemAvailable', () => {
    expect(parseNetDev(NET(1000, 500))).toEqual({ rx: 1000, tx: 500 });
    expect(parseNetDev('garbage')).toBeNull();
    expect(parseMemAvailable('MemTotal:       2000 kB\nMemFree: 1 kB\nMemAvailable:    500 kB\n')).toEqual({ total: 2048000, available: 512000 });
  });

  it('CPU và Net tính theo khoảng giữa hai lần đọc; RAM/Disk theo %', () => {
    const d = deps();
    const read = createSystemReader('/data', d);
    d.tick(100, 300, 1000, 500, 1000);
    const first = read();
    expect(first.cpuPercent).toBe(25);
    expect(first.netInBps).toBeNull();
    expect(first.ramPercent).toBe(75);
    expect(first.diskPercent).toBe(66.7);
    d.tick(190, 310, 3000, 1500, 3000);
    const second = read();
    expect(second.cpuPercent).toBe(90);
    expect(second.netInBps).toBe(1000);
    expect(second.netOutBps).toBe(500);
    expect(second.healthy).toBe(false);
  });

  it('thiếu /proc và statfs lỗi (Windows/dev) → null, không ném lỗi', () => {
    const read = createSystemReader('/data', deps({ readText: () => null, statfs: () => { throw new Error('no'); }, cpus: () => [] }));
    const r = read();
    expect(r.diskPercent).toBeNull();
    expect(r.netInBps).toBeNull();
    expect(r.cpuPercent).toBeNull();
    expect(r.ramPercent).toBe(75);
    expect(r.healthy).toBe(true);
  });
});
