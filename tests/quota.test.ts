import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgyQuota,
  readCodexLimits,
  readEnergy,
  type EnergyWindow,
  type EnergyReading
} from '../src/energy/quota.ts';

describe('parseAgyQuota', () => {
  const sampleAgyOutput = JSON.stringify({
    response: [
      'Gemini Models\tWeekly Limit Remaining\t63%\t2026-11-15T00:22:39Z',
      'Gemini Models\tFive Hour Limit Remaining\t83%\t2026-11-08T19:57:00Z',
      'Claude and GPT models\tWeekly Limit Remaining\t50%\t2026-11-15T00:22:39Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-08T19:57:00Z'
    ].join('\n')
  });

  it('phân tích đúng mẫu thật 2026-11-08 (Gemini Models mặc định)', () => {
    const windows = parseAgyQuota(sampleAgyOutput);
    expect(windows).toEqual([
      { name: '5h', remainingPercent: 83, resetsAt: '2026-11-08T19:57:00Z' },
      { name: 'week', remainingPercent: 63, resetsAt: '2026-11-15T00:22:39Z' }
    ]);
  });

  it('hỗ trợ chỉ định nhóm khác (Claude and GPT models)', () => {
    const windows = parseAgyQuota(sampleAgyOutput, 'Claude and GPT models');
    expect(windows).toEqual([
      { name: '5h', remainingPercent: 100, resetsAt: '2026-11-08T19:57:00Z' },
      { name: 'week', remainingPercent: 50, resetsAt: '2026-11-15T00:22:39Z' }
    ]);
  });

  it('xử lý chuỗi có chứa mã ANSI hoặc bọc trong output của terminal', () => {
    const wrappedOutput = `Script started\r\n\x1b[32m${sampleAgyOutput}\x1b[0m\r\nScript done`;
    const windows = parseAgyQuota(wrappedOutput);
    expect(windows).toEqual([
      { name: '5h', remainingPercent: 83, resetsAt: '2026-11-08T19:57:00Z' },
      { name: 'week', remainingPercent: 63, resetsAt: '2026-11-15T00:22:39Z' }
    ]);
  });

  it('trả về null khi JSON hỏng', () => {
    expect(parseAgyQuota('not valid json')).toBeNull();
    expect(parseAgyQuota('{"response":')).toBeNull();
  });

  it('trả về null khi thiếu trường response hoặc response không phải chuỗi', () => {
    expect(parseAgyQuota('{}')).toBeNull();
    expect(parseAgyQuota(JSON.stringify({ response: 123 }))).toBeNull();
  });

  it('trả về null khi thiếu dòng Five Hour hoặc Weekly', () => {
    const missingFiveHour = JSON.stringify({
      response: 'Gemini Models\tWeekly Limit Remaining\t63%\t2026-11-15T00:22:39Z'
    });
    expect(parseAgyQuota(missingFiveHour)).toBeNull();

    const missingWeekly = JSON.stringify({
      response: 'Gemini Models\tFive Hour Limit Remaining\t83%\t2026-11-08T19:57:00Z'
    });
    expect(parseAgyQuota(missingWeekly)).toBeNull();
  });

  it('trả về null khi nhóm không khớp', () => {
    expect(parseAgyQuota(sampleAgyOutput, 'Nonexistent Group')).toBeNull();
  });

  it('trả về null khi giá trị % không hữu hạn hoặc ngoài khoảng 0–100', () => {
    const over100 = JSON.stringify({
      response: [
        'Gemini Models\tWeekly Limit Remaining\t120%\t2026-11-15T00:22:39Z',
        'Gemini Models\tFive Hour Limit Remaining\t83%\t2026-11-08T19:57:00Z'
      ].join('\n')
    });
    expect(parseAgyQuota(over100)).toBeNull();

    const negative = JSON.stringify({
      response: [
        'Gemini Models\tWeekly Limit Remaining\t-5%\t2026-11-15T00:22:39Z',
        'Gemini Models\tFive Hour Limit Remaining\t83%\t2026-11-08T19:57:00Z'
      ].join('\n')
    });
    expect(parseAgyQuota(negative)).toBeNull();
  });

  it('không làm tròn % số thực của agy', () => {
    const floatQuota = JSON.stringify({
      response: [
        'Gemini Models\tWeekly Limit Remaining\t63.456%\t2026-11-15T00:22:39Z',
        'Gemini Models\tFive Hour Limit Remaining\t83.123%\t2026-11-08T19:57:00Z'
      ].join('\n')
    });
    const windows = parseAgyQuota(floatQuota);
    expect(windows).toEqual([
      { name: '5h', remainingPercent: 83.123, resetsAt: '2026-11-08T19:57:00Z' },
      { name: 'week', remainingPercent: 63.456, resetsAt: '2026-11-15T00:22:39Z' }
    ]);
  });
});

describe('readCodexLimits', () => {
  it('trả về null khi không có thư mục sessions', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-empty-'));
    expect(readCodexLimits(tempDir)).toBeNull();
  });

  it('trả về null khi thư mục sessions rỗng hoặc không có file jsonl', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-nosess-'));
    mkdirSync(join(tempDir, 'sessions'), { recursive: true });
    expect(readCodexLimits(tempDir)).toBeNull();
  });

  it('quét từ cuối lên: bỏ qua dòng cuối hỏng và lấy dòng trước hợp lệ', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-lastbad-'));
    const sessDir = join(tempDir, 'sessions', '2026', '11', '08');
    mkdirSync(sessDir, { recursive: true });
    const filePath = join(sessDir, 'rollout-1.jsonl');

    const validRecord = {
      timestamp: '2026-11-08T14:50:00.000Z',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 4.0, window_minutes: 300, resets_at: 1794159978 },
          secondary: { used_percent: 30.0, window_minutes: 10080, resets_at: 1794385920 }
        }
      }
    };
    const corruptedLine = '{"timestamp":"2026-11-08T14:52:00.000Z","partial_broken_json';

    writeFileSync(filePath, `${JSON.stringify(validRecord)}\n${corruptedLine}\n`);

    const result = readCodexLimits(tempDir);
    expect(result).not.toBeNull();
    expect(result!.at).toBe('2026-11-08T14:50:00.000Z');
    expect(result!.windows).toEqual([
      { name: '5h', remainingPercent: 96, resetsAt: new Date(1794159978 * 1000).toISOString() },
      { name: 'week', remainingPercent: 70, resetsAt: new Date(1794385920 * 1000).toISOString() }
    ]);
  });

  it('chọn file *.jsonl mới nhất theo mtime khi có nhiều file trong sessions', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-multi-'));
    const sessDir = join(tempDir, 'sessions', '2026', '11', '08');
    mkdirSync(sessDir, { recursive: true });

    const file1 = join(sessDir, 'rollout-older.jsonl');
    const file2 = join(sessDir, 'rollout-newer.jsonl');

    const oldRecord = {
      timestamp: '2026-11-08T10:00:00.000Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 50.0, window_minutes: 300, resets_at: 1794150000 },
          secondary: { used_percent: 50.0, window_minutes: 10080, resets_at: 1794350000 }
        }
      }
    };
    const newRecord = {
      timestamp: '2026-11-08T14:00:00.000Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 10.0, window_minutes: 300, resets_at: 1794160000 },
          secondary: { used_percent: 20.0, window_minutes: 10080, resets_at: 1794390000 }
        }
      }
    };

    writeFileSync(file1, `${JSON.stringify(oldRecord)}\n`);
    writeFileSync(file2, `${JSON.stringify(newRecord)}\n`);

    // Gán mtime rõ ràng: file1 cũ hơn file2
    utimesSync(file1, new Date('2026-11-08T10:00:00Z'), new Date('2026-11-08T10:00:00Z'));
    utimesSync(file2, new Date('2026-11-08T14:00:00Z'), new Date('2026-11-08T14:00:00Z'));

    const result = readCodexLimits(tempDir);
    expect(result).not.toBeNull();
    expect(result!.at).toBe('2026-11-08T14:00:00.000Z');
    expect(result!.windows[0].remainingPercent).toBe(90);
    expect(result!.windows[1].remainingPercent).toBe(80);
  });

  it('hỗ trợ cấu trúc rate_limits trực tiếp ở root', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-root-'));
    const sessDir = join(tempDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });
    const file = join(sessDir, 'session.jsonl');

    const record = {
      timestamp: '2026-11-08T12:00:00.000Z',
      rate_limits: {
        primary: { used_percent: 5.0, window_minutes: 300, resets_at: 1794160000 },
        secondary: { used_percent: 15.0, window_minutes: 10080, resets_at: 1794390000 }
      }
    };
    writeFileSync(file, `${JSON.stringify(record)}\n`);

    const result = readCodexLimits(tempDir);
    expect(result).not.toBeNull();
    expect(result!.windows[0].remainingPercent).toBe(95);
    expect(result!.windows[1].remainingPercent).toBe(85);
  });

  it('trả về null nếu file jsonl không có bản ghi rate_limits hợp lệ nào', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-norate-'));
    const sessDir = join(tempDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });
    const file = join(sessDir, 'empty-events.jsonl');

    writeFileSync(file, '{"event":"start"}\n{"event":"stop"}\n');

    expect(readCodexLimits(tempDir)).toBeNull();
  });

  it('bỏ qua bản ghi có used_percent ngoài khoảng 0–100 hoặc không hữu hạn', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-bounds-'));
    const sessDir = join(tempDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });
    const file = join(sessDir, 'session.jsonl');

    const outOfBoundsRecord = {
      timestamp: '2026-11-08T12:00:00.000Z',
      rate_limits: {
        primary: { used_percent: 105.0, window_minutes: 300, resets_at: 1794160000 },
        secondary: { used_percent: 15.0, window_minutes: 10080, resets_at: 1794390000 }
      }
    };
    writeFileSync(file, `${JSON.stringify(outOfBoundsRecord)}\n`);

    expect(readCodexLimits(tempDir)).toBeNull();
  });

  it('không làm tròn: remainingPercent = 100 - used_percent giữ số thực', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-float-'));
    const sessDir = join(tempDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });
    const file = join(sessDir, 'session.jsonl');

    const record = {
      timestamp: '2026-11-08T12:00:00.000Z',
      rate_limits: {
        primary: { used_percent: 4.333, window_minutes: 300, resets_at: 1794160000 },
        secondary: { used_percent: 15.1234, window_minutes: 10080, resets_at: 1794390000 }
      }
    };
    writeFileSync(file, `${JSON.stringify(record)}\n`);

    const result = readCodexLimits(tempDir);
    expect(result).not.toBeNull();
    expect(result!.windows[0].remainingPercent).toBe(100 - 4.333);
    expect(result!.windows[1].remainingPercent).toBe(100 - 15.1234);
  });

  it('chỉ đọc file jsonl mới nhất; không lùi sang file cũ khi file mới nhất không có rate_limits hợp lệ', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-nofallback-'));
    const sessDir = join(tempDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });

    const olderFile = join(sessDir, 'older.jsonl');
    const newerFile = join(sessDir, 'newer.jsonl');

    const validRecord = {
      timestamp: '2026-11-08T10:00:00.000Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 10.0, window_minutes: 300, resets_at: 1794150000 },
          secondary: { used_percent: 20.0, window_minutes: 10080, resets_at: 1794350000 }
        }
      }
    };

    writeFileSync(olderFile, `${JSON.stringify(validRecord)}\n`);
    writeFileSync(newerFile, '{"event":"start"}\n{"event":"message"}\n');

    utimesSync(olderFile, new Date('2026-11-08T10:00:00Z'), new Date('2026-11-08T10:00:00Z'));
    utimesSync(newerFile, new Date('2026-11-08T14:00:00Z'), new Date('2026-11-08T14:00:00Z'));

    const result = readCodexLimits(tempDir);
    expect(result).toBeNull();
  });
});

describe('readEnergy', () => {
  const fixedNow = new Date('2026-11-08T15:00:00.000Z');
  const now = () => fixedNow;

  it('claude-code: trả về unknown với note "CLI không có lệnh hạn mức"', async () => {
    const runCalls: string[][] = [];
    const run = async (argv: string[]) => {
      runCalls.push(argv);
      return { exitCode: 0, timedOut: false, durationMs: 10, output: '' };
    };

    const reading = await readEnergy('claude', 'claude-code', {
      run,
      codexHome: '/tmp/codex',
      now
    });

    expect(runCalls.length).toBe(0);
    expect(reading).toEqual({
      agent: 'claude',
      status: 'unknown',
      windows: [],
      readAt: fixedNow.toISOString(),
      note: 'CLI không có lệnh hạn mức'
    });
  });

  it('antigravity-cli: chạy đúng lệnh agy /quota qua script -qec và trả về fresh', async () => {
    const runCalls: string[][] = [];
    const sampleOutput = JSON.stringify({
      response: [
        'Gemini Models\tWeekly Limit Remaining\t63%\t2026-11-15T00:22:39Z',
        'Gemini Models\tFive Hour Limit Remaining\t83%\t2026-11-08T19:57:00Z'
      ].join('\n')
    });

    const run = async (argv: string[]) => {
      runCalls.push(argv);
      return { exitCode: 0, timedOut: false, durationMs: 100, output: sampleOutput };
    };

    const reading = await readEnergy('victor', 'antigravity-cli', {
      run,
      codexHome: '/tmp/codex',
      now
    });

    expect(runCalls).toEqual([
      ['script', '-qec', 'agy -p /quota --output-format json --print-timeout 50s', '/dev/null']
    ]);
    expect(reading).toEqual({
      agent: 'victor',
      status: 'fresh',
      windows: [
        { name: '5h', remainingPercent: 83, resetsAt: '2026-11-08T19:57:00Z' },
        { name: 'week', remainingPercent: 63, resetsAt: '2026-11-15T00:22:39Z' }
      ],
      readAt: fixedNow.toISOString()
    });
  });

  it('antigravity-cli: trả về unknown khi run ném lỗi (exception)', async () => {
    const run = async () => {
      throw new Error('Command failed: script not found');
    };

    const reading = await readEnergy('victor', 'antigravity-cli', {
      run,
      codexHome: '/tmp/codex',
      now
    });

    expect(reading.status).toBe('unknown');
    expect(reading.windows).toEqual([]);
    expect(reading.note).toContain('Command failed');
  });

  it('antigravity-cli: trả về unknown khi lệnh timed out', async () => {
    const run = async () => ({
      exitCode: null,
      timedOut: true,
      durationMs: 60000,
      output: ''
    });

    const reading = await readEnergy('victor', 'antigravity-cli', {
      run,
      codexHome: '/tmp/codex',
      now
    });

    expect(reading.status).toBe('unknown');
    expect(reading.note).toMatch(/timeout|quá thời gian/i);
  });

  it('antigravity-cli: trả về unknown khi exit code khác 0 hoặc output hỏng', async () => {
    const run = async () => ({
      exitCode: 1,
      timedOut: false,
      durationMs: 50,
      output: 'Please login first'
    });

    const reading = await readEnergy('victor', 'antigravity-cli', {
      run,
      codexHome: '/tmp/codex',
      now
    });

    expect(reading.status).toBe('unknown');
    expect(reading.windows).toEqual([]);
    expect(reading.note).toBeTruthy();
  });

  it('antigravity-cli: tự đặt timeout 60 s bằng Promise.race quanh deps.run → unknown khi quá giờ', async () => {
    vi.useFakeTimers();
    try {
      let runStarted = false;
      const run = () =>
        new Promise<any>((resolve) => {
          runStarted = true;
          setTimeout(() => resolve({ exitCode: 0, timedOut: false, durationMs: 70000, output: '{}' }), 70000);
        });

      const readingPromise = readEnergy('victor', 'antigravity-cli', {
        run,
        codexHome: '/tmp/codex',
        now
      });

      await vi.advanceTimersByTimeAsync(60000);

      const reading = await readingPromise;
      expect(runStarted).toBe(true);
      expect(reading.status).toBe('unknown');
      expect(reading.windows).toEqual([]);
      expect(reading.note).toMatch(/timeout|quá thời gian/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('antigravity-cli: exit 0 nhưng output rỗng → trả về unknown', async () => {
    const run = async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 50,
      output: ''
    });

    const reading = await readEnergy('victor', 'antigravity-cli', {
      run,
      codexHome: '/tmp/codex',
      now
    });

    expect(reading.status).toBe('unknown');
    expect(reading.windows).toEqual([]);
    expect(reading.note).toBeTruthy();
  });

  it('antigravity-cli: exit 0 nhưng JSON hỏng → trả về unknown', async () => {
    const run = async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 50,
      output: '{"response": {not-valid-json'
    });

    const reading = await readEnergy('victor', 'antigravity-cli', {
      run,
      codexHome: '/tmp/codex',
      now
    });

    expect(reading.status).toBe('unknown');
    expect(reading.windows).toEqual([]);
    expect(reading.note).toBeTruthy();
  });

  it('antigravity-cli: exit 0 nhưng response đổi định dạng → trả về unknown', async () => {
    const runNoResponseField = async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 50,
      output: JSON.stringify({ other_data: 'some string' })
    });

    const reading1 = await readEnergy('victor', 'antigravity-cli', {
      run: runNoResponseField,
      codexHome: '/tmp/codex',
      now
    });

    expect(reading1.status).toBe('unknown');
    expect(reading1.windows).toEqual([]);

    const runChangedFormat = async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 50,
      output: JSON.stringify({ response: 'Status: OK\nAll limits are good\n' })
    });

    const reading2 = await readEnergy('victor', 'antigravity-cli', {
      run: runChangedFormat,
      codexHome: '/tmp/codex',
      now
    });

    expect(reading2.status).toBe('unknown');
    expect(reading2.windows).toEqual([]);
    expect(reading2.note).toMatch(/không phân tích được/i);
  });

  it('codex-cli: đọc hạn mức từ file sessions codex thành công', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-reading-'));
    const sessDir = join(tempDir, 'sessions');
    mkdirSync(sessDir, { recursive: true });

    const record = {
      timestamp: '2026-11-08T14:40:00.000Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 5.0, window_minutes: 300, resets_at: 1794159978 },
          secondary: { used_percent: 25.0, window_minutes: 10080, resets_at: 1794385920 }
        }
      }
    };
    writeFileSync(join(sessDir, 'rollout.jsonl'), `${JSON.stringify(record)}\n`);

    const run = async () => {
      throw new Error('should not run CLI for codex');
    };

    const reading = await readEnergy('qeen', 'codex-cli', {
      run,
      codexHome: tempDir,
      now
    });

    expect(reading).toEqual({
      agent: 'qeen',
      status: 'fresh',
      windows: [
        { name: '5h', remainingPercent: 95, resetsAt: new Date(1794159978 * 1000).toISOString() },
        { name: 'week', remainingPercent: 75, resetsAt: new Date(1794385920 * 1000).toISOString() }
      ],
      readAt: '2026-11-08T14:40:00.000Z'
    });
  });

  it('codex-cli: trả về unknown khi không có dữ liệu sessions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'btm-codex-nosess-'));
    const run = async () => ({ exitCode: 0, timedOut: false, durationMs: 0, output: '' });

    const reading = await readEnergy('qeen', 'codex-cli', {
      run,
      codexHome: tempDir,
      now
    });

    expect(reading.status).toBe('unknown');
    expect(reading.windows).toEqual([]);
    expect(reading.note).toBeTruthy();
  });
});
