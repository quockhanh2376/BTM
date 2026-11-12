import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Config } from '../config.ts';

// Plan 6 Task 1 (decision 0004): báo anh Zon qua ntfy khi phiên cần anh. Tin nhắn chỉ gồm mẫu cố định + mã lý do
// đã lọc, không chép chữ tự do của agent. Địa chỉ topic nằm trong file ngoài git (0600, user agent).

export type NotifyKind = 'needs_owner' | 'awaiting_approval' | 'done' | 'stopped' | 'out_of_turns' | 'account_switch' | 'account_logout';

// Plan 7: tin về tài khoản luôn gửi khi đã cấu hình notify (anh Zon yêu cầu), không cần nằm trong notify.on.
const ALWAYS: ReadonlySet<NotifyKind> = new Set(['account_switch', 'account_logout']);

export interface NotifyEvent {
  kind: NotifyKind;
  project: string;
  notes?: string[];
}

export interface NotifyDeps {
  send: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<unknown>;
  readUrl: (file: string) => string;
  now: () => number;
  log: (msg: string) => void;
}

const DEDUPE_MS = 10 * 60 * 1000;
const lastSent = new Map<string, number>();

// Mã lý do: lấy từ đầu tiên của note đầu, chỉ giữ ký tự an toàn. "energy:5h còn 15%…" → "energy:5h".
export function reasonCode(notes: string[] | undefined): string {
  const first = (notes ?? []).find((n) => typeof n === 'string' && n.trim()) ?? '';
  const code = first.trim().split(/\s/)[0]!.replace(/[^A-Za-z0-9_:.%-]/g, '').slice(0, 60);
  return code || '-';
}

const LABEL: Record<NotifyKind, string> = {
  needs_owner: 'Needs you',
  awaiting_approval: 'Awaiting approval',
  done: 'Done',
  stopped: 'Stopped',
  out_of_turns: 'Out of turns',
  account_switch: 'Account switched',
  account_logout: 'Account logged out (maybe used on another machine)',
};

function defaultDeps(): NotifyDeps {
  return {
    send: (url, init) => fetch(url, init),
    readUrl: (file) => readFileSync(file, 'utf8').trim(),
    now: () => Date.now(),
    log: (msg) => console.log(msg),
  };
}

export async function notify(cfg: Config, ev: NotifyEvent, deps: NotifyDeps = defaultDeps()): Promise<void> {
  const n = cfg.notify;
  if (!n || (!ALWAYS.has(ev.kind) && !(n.on as string[]).includes(ev.kind))) return;
  const project = basename(ev.project || '-').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || '-';
  const reason = reasonCode(ev.notes);
  const key = `${ev.kind}|${project}|${reason}`;
  const now = deps.now();
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < DEDUPE_MS) return;
  lastSent.set(key, now);
  try {
    const url = deps.readUrl(n.url_file);
    if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error('notify url must be https');
    const headers: Record<string, string> = { Title: `BTM ${project}`, Tags: ev.kind === 'done' ? 'white_check_mark' : 'bell' };
    if (n.dashboard_url) headers.Click = n.dashboard_url;
    await deps.send(url, {
      method: 'POST',
      headers,
      body: `${LABEL[ev.kind]} · ${reason}`,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Gửi lỗi không được làm hỏng phiên; không in URL (topic là bí mật).
    deps.log(`[notify] send failed: ${err instanceof Error ? err.name : 'error'}`);
  }
}

export function resetNotifyDedupe(): void {
  lastSent.clear();
}
