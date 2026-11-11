import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMonitor } from '../src/energy/monitor.ts';
import { openStore, type Store } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { EnergyReading } from '../src/energy/quota.ts';
import type { LoginHealth } from '../src/energy/login.ts';

describe('Energy Monitor', () => {
  let store: Store;
  let cfg: Config;
  let nowTime: Date;
  const now = () => nowTime;

  beforeEach(() => {
    store = openStore(':memory:');
    cfg = loadConfig('btm.config.yaml');
    nowTime = new Date('2026-11-08T15:00:00.000Z');
  });

  describe('gate', () => {
    it('cho qua (ok: true) khi chưa có bản ghi nào trong store', () => {
      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: vi.fn(),
        checkLogin: vi.fn(),
        now,
      });

      expect(monitor.gate('jacky')).toEqual({ ok: true });
    });

    it('chặn khi login state là relogin (reason: login:relogin)', () => {
      store.saveLogin({
        agent: 'jacky',
        state: 'relogin',
        detail: 'Cần đăng nhập lại',
      });

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: vi.fn(),
        checkLogin: vi.fn(),
        now,
      });

      expect(monitor.gate('jacky')).toEqual({
        ok: false,
        reason: 'login:relogin',
      });
    });

    it('chặn khi login state là api_key (reason: login:api_key)', () => {
      store.saveLogin({
        agent: 'jenny',
        state: 'api_key',
        detail: 'API key đè đăng nhập',
      });

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: vi.fn(),
        checkLogin: vi.fn(),
        now,
      });

      expect(monitor.gate('jenny')).toEqual({
        ok: false,
        reason: 'login:api_key',
      });
    });

    it('energy unknown -> cho qua (ok: true), không chặn phiên', () => {
      store.saveEnergy({
        agent: 'jacky',
        status: 'unknown',
        windows: [],
        readAt: '2026-11-08T15:00:00.000Z',
        note: 'CLI không có lệnh hạn mức',
      });
      store.saveLogin({
        agent: 'jacky',
        state: 'ok',
        detail: 'Ok',
      });

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: vi.fn(),
        checkLogin: vi.fn(),
        now,
      });

      expect(monitor.gate('jacky')).toEqual({ ok: true });
    });

    it('energy fresh nhưng 15% < min_remaining_percent (20) -> chặn kèm giờ hồi', () => {
      store.saveEnergy({
        agent: 'jacky',
        status: 'fresh',
        windows: [
          { name: '5h', remainingPercent: 15, resetsAt: '2026-11-08T19:57:00Z' },
          { name: 'week', remainingPercent: 63, resetsAt: '2026-11-15T00:22:39Z' },
        ],
        readAt: '2026-11-08T15:00:00.000Z',
      });
      store.saveLogin({
        agent: 'jacky',
        state: 'ok',
        detail: 'Ok',
      });

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: vi.fn(),
        checkLogin: vi.fn(),
        now,
      });

      expect(monitor.gate('jacky')).toEqual({
        ok: false,
        reason: 'energy:5h còn 15%, hồi lúc 19:57',
      });
    });

    it('cửa sổ week có % thấp hơn và dưới ngưỡng -> chặn với cửa sổ week', () => {
      store.saveEnergy({
        agent: 'jenny',
        status: 'fresh',
        windows: [
          { name: '5h', remainingPercent: 40, resetsAt: '2026-11-08T19:57:00Z' },
          { name: 'week', remainingPercent: 12, resetsAt: '2026-11-15T00:22:39Z' },
        ],
        readAt: '2026-11-08T15:00:00.000Z',
      });
      store.saveLogin({
        agent: 'jenny',
        state: 'ok',
        detail: 'Ok',
      });

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: vi.fn(),
        checkLogin: vi.fn(),
        now,
      });

      expect(monitor.gate('jenny')).toEqual({
        ok: false,
        reason: 'energy:week còn 12%, hồi lúc 00:22',
      });
    });

    it('energy fresh và tất cả cửa sổ >= min_remaining_percent -> cho qua (ok: true)', () => {
      store.saveEnergy({
        agent: 'jacky',
        status: 'fresh',
        windows: [
          { name: '5h', remainingPercent: 20, resetsAt: '2026-11-08T19:57:00Z' },
          { name: 'week', remainingPercent: 63, resetsAt: '2026-11-15T00:22:39Z' },
        ],
        readAt: '2026-11-08T15:00:00.000Z',
      });
      store.saveLogin({
        agent: 'jacky',
        state: 'ok',
        detail: 'Ok',
      });

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: vi.fn(),
        checkLogin: vi.fn(),
        now,
      });

      expect(monitor.gate('jacky')).toEqual({ ok: true });
    });
  });

  describe('refresh và cache', () => {
    it('refresh đọc energy và login cho agent và lưu vào store', async () => {
      const mockReadEnergy = vi.fn().mockResolvedValue({
        agent: 'jacky',
        status: 'fresh',
        windows: [{ name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T19:57:00Z' }],
        readAt: '2026-11-08T15:00:00.000Z',
      } as EnergyReading);

      const mockCheckLogin = vi.fn().mockResolvedValue({
        agent: 'jacky',
        state: 'ok',
        detail: 'Ok',
      } as LoginHealth);

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: mockReadEnergy,
        checkLogin: mockCheckLogin,
        now,
      });

      await monitor.refresh(['jacky']);

      expect(mockReadEnergy).toHaveBeenCalledTimes(1);
      expect(mockCheckLogin).toHaveBeenCalledTimes(1);

      // agyQuotaOk được truyền từ kết quả fresh của readEnergy
      expect(mockCheckLogin).toHaveBeenCalledWith(
        'jacky',
        'antigravity-cli',
        expect.objectContaining({
          agyQuotaOk: true,
        })
      );

      const latestEnergy = store.latestEnergy('jacky');
      expect(latestEnergy?.status).toBe('fresh');
      expect(latestEnergy?.windows[0].remainingPercent).toBe(80);

      const latestLogin = store.latestLogin('jacky');
      expect(latestLogin?.state).toBe('ok');
    });

    it('refresh cho agy truyền agyQuotaOk: false và agyQuotaOutput khi readEnergy trả về unknown có note', async () => {
      const mockReadEnergy = vi.fn().mockResolvedValue({
        agent: 'jacky',
        status: 'unknown',
        windows: [],
        readAt: '2026-11-08T15:00:00.000Z',
        note: 'Lệnh agy /quota thất bại: please login first',
      } as EnergyReading);

      const mockCheckLogin = vi.fn().mockResolvedValue({
        agent: 'jacky',
        state: 'relogin',
        detail: 'Cần đăng nhập lại',
      } as LoginHealth);

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: mockReadEnergy,
        checkLogin: mockCheckLogin,
        now,
      });

      await monitor.refresh(['jacky']);

      expect(mockCheckLogin).toHaveBeenCalledWith(
        'jacky',
        'antigravity-cli',
        expect.objectContaining({
          agyQuotaOk: false,
          agyQuotaOutput: 'Lệnh agy /quota thất bại: please login first',
        })
      );
    });

    it('2 lần refresh trong cache_seconds chỉ đọc 1 lần', async () => {
      const mockReadEnergy = vi.fn().mockResolvedValue({
        agent: 'jacky',
        status: 'fresh',
        windows: [{ name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T19:57:00Z' }],
        readAt: nowTime.toISOString(),
      } as EnergyReading);

      const mockCheckLogin = vi.fn().mockResolvedValue({
        agent: 'jacky',
        state: 'ok',
        detail: 'Ok',
      } as LoginHealth);

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: mockReadEnergy,
        checkLogin: mockCheckLogin,
        now,
      });

      // Lần 1: đọc
      await monitor.refresh(['jacky']);
      expect(mockReadEnergy).toHaveBeenCalledTimes(1);
      expect(mockCheckLogin).toHaveBeenCalledTimes(1);

      // Tiến thời gian 60s (vẫn trong cache_seconds = 180s)
      nowTime = new Date(nowTime.getTime() + 60_000);

      // Lần 2: không đọc lại do còn cache
      await monitor.refresh(['jacky']);
      expect(mockReadEnergy).toHaveBeenCalledTimes(1);
      expect(mockCheckLogin).toHaveBeenCalledTimes(1);

      // Tiến thời gian qua 180s (ví dụ 185s tính từ lúc đọc)
      nowTime = new Date(nowTime.getTime() + 130_000); // tổng 190s > 180s

      // Lần 3: hết cache, đọc lại
      await monitor.refresh(['jacky']);
      expect(mockReadEnergy).toHaveBeenCalledTimes(2);
      expect(mockCheckLogin).toHaveBeenCalledTimes(2);
    });

    it('force = true tôn trọng cache tối thiểu 30 s', async () => {
      const mockReadEnergy = vi.fn().mockResolvedValue({
        agent: 'jacky',
        status: 'fresh',
        windows: [{ name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T19:57:00Z' }],
        readAt: nowTime.toISOString(),
      } as EnergyReading);

      const mockCheckLogin = vi.fn().mockResolvedValue({
        agent: 'jacky',
        state: 'ok',
        detail: 'Ok',
      } as LoginHealth);

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: mockReadEnergy,
        checkLogin: mockCheckLogin,
        now,
      });

      // Lần 1: đọc
      await monitor.refresh(['jacky']);
      expect(mockReadEnergy).toHaveBeenCalledTimes(1);

      // Tiến thời gian 15s (< 30s) và gọi force: true
      nowTime = new Date(nowTime.getTime() + 15_000);
      await monitor.refresh(['jacky'], true);
      // Vẫn không đọc vì chưa đủ 30s
      expect(mockReadEnergy).toHaveBeenCalledTimes(1);

      // Tiến thời gian thêm 20s (tổng 35s >= 30s) và gọi force: true
      nowTime = new Date(nowTime.getTime() + 20_000);
      await monitor.refresh(['jacky'], true);
      // Đã đủ 30s -> đọc lại
      expect(mockReadEnergy).toHaveBeenCalledTimes(2);
    });

    it('cache theo thời điểm monitor đọc (checkedAt), không theo readAt của codex (dù readAt cũ vẫn cache đúng)', async () => {
      // Dữ liệu codex có readAt từ 3 tiếng trước
      const oldCodexTimestamp = new Date(nowTime.getTime() - 3 * 3600 * 1000).toISOString();
      const mockReadEnergy = vi.fn().mockResolvedValue({
        agent: 'jenny',
        status: 'fresh',
        windows: [{ name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T19:57:00Z' }],
        readAt: oldCodexTimestamp,
      } as EnergyReading);

      const mockCheckLogin = vi.fn().mockResolvedValue({
        agent: 'jenny',
        state: 'ok',
        detail: 'Ok',
      } as LoginHealth);

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: mockReadEnergy,
        checkLogin: mockCheckLogin,
        now,
      });

      // Lần 1: đọc
      await monitor.refresh(['jenny']);
      expect(mockReadEnergy).toHaveBeenCalledTimes(1);

      // Tiến thời gian 30s (< cache_seconds = 180s)
      nowTime = new Date(nowTime.getTime() + 30_000);

      // Lần 2: không đọc lại dù readAt của codex rất cũ, vì monitor vừa mới đọc 30s trước
      await monitor.refresh(['jenny']);
      expect(mockReadEnergy).toHaveBeenCalledTimes(1);

      // Tiến thời gian qua 180s (ví dụ +160s nữa -> 190s > 180s tính từ lúc đọc)
      nowTime = new Date(nowTime.getTime() + 160_000);

      // Lần 3: hết cache_seconds -> đọc lại
      await monitor.refresh(['jenny']);
      expect(mockReadEnergy).toHaveBeenCalledTimes(2);
    });

    it('gộp refresh đồng thời theo agent: Map<agent, Promise> đang chạy, lời gọi thứ hai dùng lại promise', async () => {
      let resolveEnergy: (val: EnergyReading) => void;
      const energyPromise = new Promise<EnergyReading>((res) => {
        resolveEnergy = res;
      });

      const mockReadEnergy = vi.fn().mockImplementation(() => energyPromise);
      const mockCheckLogin = vi.fn().mockResolvedValue({
        agent: 'jacky',
        state: 'ok',
        detail: 'Ok',
      } as LoginHealth);

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: mockReadEnergy,
        checkLogin: mockCheckLogin,
        now,
      });

      // Hai lời gọi refresh đồng thời cho cùng 1 agent
      const p1 = monitor.refresh(['jacky']);
      const p2 = monitor.refresh(['jacky']);

      // Giải quyết đọc energy
      resolveEnergy!({
        agent: 'jacky',
        status: 'fresh',
        windows: [{ name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T19:57:00Z' }],
        readAt: nowTime.toISOString(),
      });

      await Promise.all([p1, p2]);

      // Chỉ gọi readEnergy 1 lần duy nhất do lời gọi thứ 2 dùng lại promise của lời gọi 1
      expect(mockReadEnergy).toHaveBeenCalledTimes(1);
      expect(mockCheckLogin).toHaveBeenCalledTimes(1);
    });
  });

  it('P4.5: cách ly → đọc hạn mức Codex trong home của user riêng của agent', async () => {
    const isoCfg = { ...cfg, host: { ...cfg.host, worker_prefix: 'btm-' } };
    const mockReadEnergy = vi.fn().mockResolvedValue({ agent: 'jenny', status: 'fresh', windows: [], readAt: '2026-11-08T15:00:00.000Z' });
    const mockCheckLogin = vi.fn().mockResolvedValue({ agent: 'jenny', state: 'ok', detail: 'Ok' });
    const monitor = createMonitor({ cfg: isoCfg, store, readEnergy: mockReadEnergy, checkLogin: mockCheckLogin, now, run: vi.fn() as any });
    await monitor.refresh(['jenny']);
    expect(JSON.stringify(mockReadEnergy.mock.calls[0])).toContain('/home/btm-jenny/.codex');
  });
});
