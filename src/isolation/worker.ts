import { execFileSync } from 'node:child_process';
import type { Config } from '../config.ts';

export type ExecFn = (file: string, args: string[], options?: { stdio?: 'ignore' | 'pipe' }) => unknown;

export function wrapForWorker(cfg: Config, argv: string[], cwd: string): string[] {
  const user = cfg.host.worker_user;
  if (!user) return argv;
  return ['sudo', '-n', '-u', user, '/usr/local/bin/btm-worker-exec', cwd, '--', ...argv];
}

export function workerKillAll(cfg: Config, exec: ExecFn = execFileSync): void {
  const user = cfg.host.worker_user;
  if (!user) return;
  try {
    exec('sudo', ['-n', '-u', user, '/usr/local/bin/btm-worker-killall'], { stdio: 'ignore' });
  } catch (err) {
    // pkill trả 1 khi không còn tiến trình nào – bình thường. Lỗi khác (sudo hỏng) phải báo.
    if ((err as { status?: number }).status !== 1) throw err;
  }
}
