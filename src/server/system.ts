import { cpus, freemem, totalmem, type CpuInfo } from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';

// Plan 9 Task 2: số liệu máy cho khung System Status ở sidebar. Chỉ đọc; thiếu nguồn (Windows/dev không có /proc) → null.

export interface SystemInfo {
  cpuPercent: number | null;
  ramPercent: number | null;
  diskPercent: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  /** Mọi số đọc được đều dưới ngưỡng HEALTHY_MAX. */
  healthy: boolean;
}

export interface SystemDeps {
  cpus: () => CpuInfo[];
  totalmem: () => number;
  freemem: () => number;
  statfs: (path: string) => { blocks: number; bfree: number; bavail: number };
  readText: (path: string) => string | null;
  now: () => number;
}

const HEALTHY_MAX = 90;

const defaultDeps: SystemDeps = {
  cpus,
  totalmem,
  freemem,
  statfs: (p) => statfsSync(p),
  readText: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

const pct = (x: number) => Math.max(0, Math.min(100, Math.round(x * 10) / 10));

function cpuTimes(list: CpuInfo[]): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of list) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// Byte nhận/gửi cộng mọi card mạng trừ lo.
export function parseNetDev(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of text.split(/\r?\n/).slice(2)) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === 'lo') continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    rx += f[0]!;
    tx += f[8]!;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

// RAM "đang dùng" theo MemAvailable (Linux: freemem không tính cache có thể giải phóng).
export function parseMemAvailable(text: string): { total: number; available: number } | null {
  const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
  const avail = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
  return total && avail ? { total: Number(total[1]) * 1024, available: Number(avail[1]) * 1024 } : null;
}

/** Trả hàm đọc; giữ mẫu CPU/mạng lần trước để tính theo khoảng giữa hai lần gọi. */
export function createSystemReader(dataDir: string, deps: SystemDeps = defaultDeps): () => SystemInfo {
  let prevCpu: { idle: number; total: number } | null = null;
  let prevNet: { rx: number; tx: number; at: number } | null = null;
  return () => {
    let cpuPercent: number | null = null;
    try {
      const cur = cpuTimes(deps.cpus());
      const base = prevCpu ?? { idle: 0, total: 0 };
      const dt = cur.total - base.total;
      if (dt > 0) cpuPercent = pct((1 - (cur.idle - base.idle) / dt) * 100);
      prevCpu = cur;
    } catch {}

    let ramPercent: number | null = null;
    try {
      const meminfo = deps.readText('/proc/meminfo');
      const m = meminfo ? parseMemAvailable(meminfo) : null;
      const total = m ? m.total : deps.totalmem();
      const free = m ? m.available : deps.freemem();
      if (total > 0) ramPercent = pct(((total - free) / total) * 100);
    } catch {}

    let diskPercent: number | null = null;
    try {
      const s = deps.statfs(dataDir);
      const used = s.blocks - s.bfree;
      const denom = used + s.bavail;
      if (denom > 0) diskPercent = pct((used / denom) * 100);
    } catch {}

    let netInBps: number | null = null;
    let netOutBps: number | null = null;
    const netText = deps.readText('/proc/net/dev');
    const net = netText ? parseNetDev(netText) : null;
    if (net) {
      const at = deps.now();
      if (prevNet && at > prevNet.at && net.rx >= prevNet.rx && net.tx >= prevNet.tx) {
        const sec = (at - prevNet.at) / 1000;
        netInBps = Math.round((net.rx - prevNet.rx) / sec);
        netOutBps = Math.round((net.tx - prevNet.tx) / sec);
      }
      prevNet = { ...net, at };
    }

    const healthy = [cpuPercent, ramPercent, diskPercent].every((v) => v === null || v < HEALTHY_MAX);
    return { cpuPercent, ramPercent, diskPercent, netInBps, netOutBps, healthy };
  };
}
