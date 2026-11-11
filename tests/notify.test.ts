import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notify, reasonCode, resetNotifyDedupe, type NotifyDeps } from '../src/notify/notify.ts';
import { ConfigSchema, loadConfig } from '../src/config.ts';

const base = loadConfig('btm.config.yaml');
const cfg = { ...base, notify: { url_file: '/var/lib/btm/notify.url', dashboard_url: 'http://127.0.0.1:8080/', on: ['needs_owner', 'awaiting_approval'] } } as any;

function deps(over: Partial<NotifyDeps> = {}) {
  const send = vi.fn(async () => ({}));
  const log = vi.fn();
  let t = 1_000_000;
  const d: NotifyDeps = { send, readUrl: () => 'https://ntfy.sh/btm-secret-topic', now: () => t, log, ...over };
  return { d, send, log, advance: (ms: number) => { t += ms; } };
}

describe('P6-T1: thông báo ntfy', () => {
  beforeEach(() => resetNotifyDedupe());

  it('gửi mẫu cố định: tiêu đề project, nội dung nhãn + mã lý do, link dashboard', async () => {
    const { d, send } = deps();
    await notify(cfg, { kind: 'needs_owner', project: '/srv/btm-repos/go-to-the-moon', notes: ['energy:5h còn 15%, hồi lúc 19:57'] }, d);
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] as any;
    expect(url).toBe('https://ntfy.sh/btm-secret-topic');
    expect(init.headers).toMatchObject({ Title: 'BTM go-to-the-moon', Click: 'http://127.0.0.1:8080/' });
    expect(init.body).toBe('Can anh xu ly · energy:5h');
  });

  it('không chép chữ tự do của agent: note chứa link/@everyone/HTML chỉ còn mã đã lọc', () => {
    expect(reasonCode(["Seat 'qc' is occupied by 'jenny'"])).toBe('Seat');
    expect(reasonCode(['<script>@everyone https://evil.example'])).toBe('scripteveryone'); // bỏ @ < > và phần sau dấu cách
    expect(reasonCode(['all_agents_exhausted', 'energy:jacky hết'])).toBe('all_agents_exhausted');
    expect(reasonCode([])).toBe('-');
  });

  it('cùng sự kiện trong 10 phút chỉ gửi 1 lần; kind không bật hoặc không cấu hình → không gửi', async () => {
    const { d, send, advance } = deps();
    const ev = { kind: 'needs_owner' as const, project: '/p/a', notes: ['x'] };
    await notify(cfg, ev, d);
    await notify(cfg, ev, d);
    expect(send).toHaveBeenCalledTimes(1);
    advance(11 * 60 * 1000);
    await notify(cfg, ev, d);
    expect(send).toHaveBeenCalledTimes(2);
    await notify(cfg, { kind: 'done', project: '/p/a' }, d);
    await notify(base, ev, d);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('lỗi mạng / URL không phải https → không ném, log không lộ topic', async () => {
    const { d, log } = deps({ send: vi.fn(async () => { throw new Error('ECONNRESET https://ntfy.sh/btm-secret-topic'); }) });
    await expect(notify(cfg, { kind: 'needs_owner', project: '/p/b', notes: ['y'] }, d)).resolves.toBeUndefined();
    const bad = deps({ readUrl: () => 'http://ntfy.sh/x' });
    await notify(cfg, { kind: 'needs_owner', project: '/p/c', notes: ['z'] }, bad.d);
    expect(bad.send).not.toHaveBeenCalled();
    expect(JSON.stringify([...log.mock.calls, ...bad.log.mock.calls])).not.toContain('btm-secret-topic');
  });

  it('config: url_file phải là đường dẫn tuyệt đối; mặc định on = needs_owner, awaiting_approval, out_of_turns', () => {
    const ok = ConfigSchema.parse({ ...base, notify: { url_file: '/var/lib/btm/notify.url' } });
    expect(ok.notify?.on).toEqual(['needs_owner', 'awaiting_approval', 'out_of_turns']);
    expect(ConfigSchema.safeParse({ ...base, notify: { url_file: 'notify.url' } }).success).toBe(false);
  });
});
