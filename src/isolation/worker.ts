import { execFileSync } from 'node:child_process';
import type { Config } from '../config.ts';

export type ExecFn = (file: string, args: string[], options?: { stdio?: 'ignore' | 'pipe'; maxBuffer?: number; timeout?: number; killSignal?: NodeJS.Signals }) => unknown;

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

// Mỗi agent một user Linux riêng (<prefix><agentId>, vd btm-elon): Dev không đụng được home/CLI/workspace của QC.
export function workerUser(cfg: Config, agentId: string): string | null {
  const prefix = cfg.host.worker_prefix;
  if (!prefix) return null;
  const user = `${prefix}${agentId}`;
  if (!USER_RE.test(user)) throw new Error(`invalid worker user: ${user}`);
  return user;
}

export function wrapForWorker(cfg: Config, agentId: string, argv: string[], cwd: string): string[] {
  const user = workerUser(cfg, agentId);
  if (!user) return argv;
  return ['sudo', '-n', '-u', user, '/usr/local/bin/btm-worker-exec', cwd, '--', ...argv];
}

export function workerKillAll(cfg: Config, agentId: string, exec: ExecFn = execFileSync): void {
  const user = workerUser(cfg, agentId);
  if (!user) return;
  try {
    exec('sudo', ['-n', '-u', user, '/usr/local/bin/btm-worker-killall'], { stdio: 'ignore' });
  } catch (err) {
    // Bản cũ (pkill) trả 1 khi không còn tiến trình – bình thường. Lỗi khác (sudo hỏng) phải báo.
    if ((err as { status?: number }).status !== 1) throw err;
  }
}

// Plan 5 Task 8: xoá cấu hình CLI/git/npm agent tự cài vào home (giữ đăng nhập) – trước mỗi lượt.
export function workerReset(cfg: Config, agentId: string, exec: ExecFn = execFileSync): void {
  const user = workerUser(cfg, agentId);
  if (!user) return;
  exec('sudo', ['-n', '-u', user, '/usr/local/bin/btm-worker-reset'], { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' });
}
