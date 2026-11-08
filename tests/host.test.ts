import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createHost } from '../src/server/host.ts';
import { tmpRepo } from './helpers.ts';
import type { Runner, TurnOutput } from '../src/runner/run.ts';
import { directPrompt } from '../src/core/prompts.ts';
import { git } from '../src/git.ts';

function deferred<T>() {
  let resolve!: (val: T | PromiseLike<T>) => void;
  let reject!: (err?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SessionHost', () => {
  let store: Store;
  let cfg: Config;
  let dataDir: string;
  let logDir: string;
  let repoDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'btm-data-'));
    logDir = mkdtempSync(join(tmpdir(), 'btm-logs-'));
    repoDir = tmpRepo({
      'team/tasks/T-001.md': `---
id: T-001
goal: Sample task
scope:
  - sample.txt
acceptance:
  - file exists
done_when: done
---
`,
      'sample.txt': 'initial content\n',
    });

    cfg = loadConfig('btm.config.yaml');
    // Ensure repoDir is considered inside projects_root
    cfg.host.projects_root = tmpdir();
    cfg.host.data_dir = dataDir;

    store = openStore(join(dataDir, 'btm.db'));
    store.setActiveProject(repoDir);
  });

  it('start hai lần liền → lần 2 error ("Đang có phiên chạy")', async () => {
    const gate = deferred<void>();
    const mockRunner: Runner = vi.fn().mockImplementation(async () => {
      await gate.promise;
      return {
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        output: 'done',
        lastMessage: 'done',
      } as TurnOutput;
    });

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const res1 = await host.start(['Goal 1']);
    expect(res1.ok).toBe(true);
    expect(host.busy()).toBe(true);

    const res2 = await host.start(['Goal 2']);
    expect(res2.ok).toBe(false);
    expect(res2.error).toMatch(/phiên/i);

    // Release gate to let session complete
    gate.resolve();
    // Wait small amount for session to finish
    await new Promise((r) => setTimeout(r, 50));
    expect(host.busy()).toBe(false);
  });

  it('giữ khóa bằng file lock của process khác (pid sống) → start bị từ chối', async () => {
    const lockPath = join(dataDir, 'btm.lock');
    // Write current process.pid (alive)
    writeFileSync(lockPath, String(process.pid));

    const mockRunner: Runner = vi.fn();
    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    expect(host.busy()).toBe(true);
    const res = await host.start(['Goal 1']);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Đang có phiên chạy');
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('stop() giữa lượt → runner nhận abort, phiên stopped, khóa được nhả, start sau đó chạy được', async () => {
    let receivedSignal: AbortSignal | undefined;
    const runnerStarted = deferred<void>();
    const runnerFinished = deferred<void>();

    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, _prompt, _cwd, _logFile, opts) => {
        receivedSignal = opts?.signal;
        runnerStarted.resolve();
        // Wait until aborted
        return new Promise<TurnOutput>((resolve, reject) => {
          if (opts?.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }).finally(() => {
          runnerFinished.resolve();
        });
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const startRes = await host.start(['Goal abort test']);
    expect(startRes.ok).toBe(true);
    expect(host.busy()).toBe(true);

    // Wait until runner starts
    await runnerStarted.promise;
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);

    // Now call stop()
    const stopRes = await host.stop();
    expect(stopRes.ok).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);

    await runnerFinished.promise;
    await new Promise((r) => setTimeout(r, 50));

    // Session status should be 'stopped'
    const latest = store.getLatestSession(undefined, repoDir);
    expect(latest).toBeDefined();
    expect(latest?.status).toBe('stopped');

    // Turn should be error with aborted
    const turns = store.listTurns(latest!.id);
    expect(turns.length).toBeGreaterThan(0);
    const lastTurn = turns[turns.length - 1];
    expect(lastTurn.result).toBe('error');
    expect(lastTurn.error).toMatch(/aborted|Interrupted/i);

    // Lock must be released
    expect(host.busy()).toBe(false);
    expect(existsSync(join(dataDir, 'btm.lock'))).toBe(false);

    // Can start again
    const mockRunner2: Runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      output: 'done',
      lastMessage: 'done',
    });
    const host2 = createHost({
      cfg,
      store,
      runner: mockRunner2,
      logDir,
      dataDir,
      env: {},
    });

    const startRes2 = await host2.start(['Goal after stop']);
    expect(startRes2.ok).toBe(true);
  });

  it('1) stop() rồi start() liền trên cùng host → start() trả về {ok:false, error:"Đang dừng phiên"} không chạy chồng, chỉ nhả khóa sau khi settle', async () => {
    const runnerStarted = deferred<void>();
    const runnerFinished = deferred<void>();
    let runnerCallCount = 0;

    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, _prompt, _cwd, _logFile, opts) => {
        runnerCallCount++;
        runnerStarted.resolve();
        return new Promise<TurnOutput>((resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            setTimeout(() => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
              runnerFinished.resolve();
            }, 60);
          });
        });
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const startRes1 = await host.start(['Session to stop']);
    expect(startRes1.ok).toBe(true);
    await runnerStarted.promise;

    // Call stop() and immediately start() on same host
    const stopRes = await host.stop();
    expect(stopRes.ok).toBe(true);

    const startRes2 = await host.start(['Immediate session']);
    expect(startRes2.ok).toBe(false);
    expect(startRes2.error).toBe('Đang dừng phiên');

    // Runner must NOT have been called for startRes2
    expect(runnerCallCount).toBe(1);
    expect(host.busy()).toBe(true);

    // Wait until runner promise settles
    await runnerFinished.promise;
    await new Promise((r) => setTimeout(r, 80));

    expect(host.busy()).toBe(false);
    expect(existsSync(join(dataDir, 'btm.lock'))).toBe(false);
  });

  it('2) stop() khi khóa do process khác giữ → trả về {ok:false, error:"Phiên đang chạy từ terminal, dừng bằng Ctrl-C"} và không sửa DB', async () => {
    const lockPath = join(dataDir, 'btm.lock');
    writeFileSync(lockPath, String(process.pid));

    const sId = store.createSession(['Terminal session'], repoDir);
    const qId = store.enqueue('dev', 'queued dev item');

    const mockRunner: Runner = vi.fn();
    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const res = await host.stop();
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Phiên đang chạy từ terminal, dừng bằng Ctrl-C');

    // DB must not be modified
    const session = store.getSession(sId);
    expect(session?.status).toBe('running');

    const queue = store.listQueue(10);
    expect(queue.find((q) => q.id === qId)?.status).toBe('queued');
  });

  it('3) khóa ngoài → command() tạo queued; nhả khóa → tick() chạy nó', async () => {
    const lockPath = join(dataDir, 'btm.lock');
    writeFileSync(lockPath, String(process.pid));

    let devCalledWith = '';
    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, prompt) => {
        devCalledWith = prompt;
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'done',
          lastMessage: 'done',
        };
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const cmdRes = await host.command('dev', 'Task waiting for external lock');
    expect(cmdRes.ok).toBe(true);
    expect(cmdRes.id).toBeDefined();

    // Verify it is still queued because external lock was held
    const q1 = store.listQueue(10);
    const item1 = q1.find((q) => q.id === cmdRes.id);
    expect(item1?.status).toBe('queued');
    expect(mockRunner).not.toHaveBeenCalled();

    // Release external lock
    const { unlinkSync } = await import('node:fs');
    unlinkSync(lockPath);

    // Call host.tick()
    await (host as any).tick();
    await new Promise((r) => setTimeout(r, 60));

    // Now it should be done
    const q2 = store.listQueue(10);
    const item2 = q2.find((q) => q.id === cmdRes.id);
    expect(item2?.status).toBe('done');
    expect(mockRunner).toHaveBeenCalled();
  });

  it('4) logDir là file → start() ném/trả lỗi nhưng khóa được nhả, host không busy', async () => {
    const fileLogDir = join(dataDir, 'logdir-is-file');
    writeFileSync(fileLogDir, 'existing file not a dir');

    const mockRunner: Runner = vi.fn();
    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir: fileLogDir,
      dataDir,
      env: {},
    });

    try {
      await host.start(['Session with bad logDir']);
    } catch {
      // It might throw or return { ok: false }
    }

    // Lock MUST be released
    expect(existsSync(join(dataDir, 'btm.lock'))).toBe(false);
    expect(host.busy()).toBe(false);
  });

  it('5) directPrompt: prompt tự do, không nhắc file thẻ; dev dùng allow, không commit; qc chỉ đọc, trả lời ngắn; host dùng nó', async () => {
    // 5.1 Check directPrompt('dev', ...)
    const devP = directPrompt('dev', 'Sửa hàm login', ['cat', 'ls']);
    expect(devP).not.toMatch(/team\/tasks/i);
    expect(devP).not.toMatch(/thẻ/i);
    expect(devP).not.toMatch(/\.md/i);
    expect(devP).toContain('cat, ls');
    expect(devP).toContain('toàn repo trừ .git');
    expect(devP).toContain('mỗi lệnh riêng lẻ');
    expect(devP).toMatch(/không.*commit|cấm.*commit/i);
    expect(devP).toContain('Sửa hàm login');

    // 5.2 Check directPrompt('qc', ...)
    const qcP = directPrompt('qc', 'Kiểm tra hàm login', []);
    expect(qcP).not.toMatch(/team\/tasks/i);
    expect(qcP).not.toMatch(/thẻ/i);
    expect(qcP).not.toMatch(/\.md/i);
    expect(qcP).toMatch(/chỉ đọc/i);
    expect(qcP).toContain('Bug');
    expect(qcP).toContain('Cần sửa');
    expect(qcP).toContain('Cần xác nhận');
    expect(qcP).toContain('Kiểm tra hàm login');

    // 5.3 Host uses directPrompt for dev and qc
    let receivedPrompt = '';
    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, prompt) => {
        receivedPrompt = prompt;
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'ok',
          lastMessage: 'ok',
        };
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    // Run direct dev command
    await host.command('dev', 'Thực hiện task tự do');
    await host.tick();
    expect(receivedPrompt).not.toMatch(/team\/tasks/i);
    expect(receivedPrompt).not.toMatch(/thẻ/i);
    expect(receivedPrompt).toContain('Thực hiện task tự do');
    expect(receivedPrompt).toMatch(/không.*commit|cấm.*commit/i);

    // Run direct qc command
    await host.command('qc', 'QC task tự do');
    await host.tick();
    expect(receivedPrompt).not.toMatch(/team\/tasks/i);
    expect(receivedPrompt).not.toMatch(/thẻ/i);
    expect(receivedPrompt).toContain('QC task tự do');
    expect(receivedPrompt).toMatch(/chỉ đọc/i);
  });

  it('6) lượt trực tiếp: phiên tạo cho nó được setSessionStatus "done" hoặc "error" khi xong', async () => {
    // 6.1 Success case -> session status 'done'
    const mockRunnerSuccess: Runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      output: 'ok',
      lastMessage: 'ok',
    });

    const host1 = createHost({
      cfg,
      store,
      runner: mockRunnerSuccess,
      logDir,
      dataDir,
      env: {},
    });

    const res1 = await host1.command('dev', 'Lệnh thành công');
    await host1.tick();
    const session1 = store.getLatestSession(undefined, repoDir);
    expect(session1).toBeDefined();
    expect(session1?.status).toBe('done');

    // 6.2 Failure case -> session status 'error'
    const mockRunnerFail: Runner = vi.fn().mockResolvedValue({
      exitCode: 1,
      timedOut: false,
      durationMs: 10,
      output: 'failed',
      lastMessage: 'error',
    });

    const host2 = createHost({
      cfg,
      store,
      runner: mockRunnerFail,
      logDir,
      dataDir,
      env: {},
    });

    const res2 = await host2.command('qc', 'Lệnh thất bại');
    await host2.tick();
    const session2 = store.getLatestSession(undefined, repoDir);
    expect(session2).toBeDefined();
    expect(session2?.id).not.toBe(session1?.id);
    expect(session2?.status).toBe('error');
  });

  it('7) command("pm", text) kiểm tra 1–2000 ký tự', async () => {
    const mockRunner: Runner = vi.fn();
    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const resEmpty = await host.command('pm', '');
    expect(resEmpty.ok).toBe(false);
    expect(resEmpty.error).toBe('Độ dài lệnh phải từ 1 đến 2000 ký tự');

    const resSpaces = await host.command('pm', '    ');
    expect(resSpaces.ok).toBe(false);
    expect(resSpaces.error).toBe('Độ dài lệnh phải từ 1 đến 2000 ký tự');

    const resTooLong = await host.command('pm', 'x'.repeat(2001));
    expect(resTooLong.ok).toBe(false);
    expect(resTooLong.error).toBe('Độ dài lệnh phải từ 1 đến 2000 ký tự');

    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('8) dev trực tiếp commit với message "cmd <id>: <60 ký tự đầu>"', async () => {
    const textLong = 'Sửa file sample.txt cho tính năng xác thực người dùng dài hơn 60 ký tự rất nhiều';
    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, _prompt, cwd) => {
        // Dev runner modifies a file
        writeFileSync(join(cwd, 'sample.txt'), 'dev updated content\n');
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'ok',
          lastMessage: 'ok',
        };
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const cmdRes = await host.command('dev', textLong);
    expect(cmdRes.ok).toBe(true);
    expect(cmdRes.id).toBeDefined();

    await host.tick();

    const expectedMsg = `cmd ${cmdRes.id}: ${textLong.slice(0, 60)}`;
    const actualCommitMsg = git(repoDir, 'log', '-1', '--format=%s').trim();
    expect(actualCommitMsg).toBe(expectedMsg);

    const author = git(repoDir, 'log', '-1', '--format=%an <%ae>').trim();
    expect(author).toBe(`${cfg.seats.dev} <${cfg.seats.dev}@btm.local>`);
  });

  it('command("dev", …) khi đang có phiên → queued, chạy sau khi phiên xong', async () => {
    const sessionGate = deferred<void>();
    const turnsCalled: string[] = [];

    const mockRunner: Runner = vi.fn().mockImplementation(
      async (seat, _agent, prompt, _cwd, _logFile) => {
        turnsCalled.push(seat);
        if (seat === 'pm') {
          await sessionGate.promise;
          return {
            exitCode: 0,
            timedOut: false,
            durationMs: 10,
            output: 'cards created',
            lastMessage: 'ok',
          };
        }
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'dev output',
          lastMessage: 'ok',
        };
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const startRes = await host.start(['Goal queue test']);
    expect(startRes.ok).toBe(true);

    // While session is running, enqueue a dev command
    const cmdRes = await host.command('dev', 'Update readme');
    expect(cmdRes.ok).toBe(true);
    expect(cmdRes.id).toBeDefined();

    // In DB, item should be 'queued'
    const queueBefore = store.listQueue(10);
    const item = queueBefore.find((q) => q.id === cmdRes.id);
    expect(item).toBeDefined();
    expect(item?.status).toBe('queued');

    // Unblock PM session so session completes
    sessionGate.resolve();
    // Wait for session and subsequent queued command to finish
    await new Promise((r) => setTimeout(r, 100));

    // Queue item should now be 'done'
    const queueAfter = store.listQueue(10);
    const itemAfter = queueAfter.find((q) => q.id === cmdRes.id);
    expect(itemAfter?.status).toBe('done');

    // Verify dev runner was called
    expect(turnsCalled).toContain('dev');
    expect(host.busy()).toBe(false);
  });

  it('stop() hủy mục queued', async () => {
    const sessionGate = deferred<void>();

    const mockRunner: Runner = vi.fn().mockImplementation(async () => {
      await sessionGate.promise;
      return {
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        output: 'done',
        lastMessage: 'done',
      };
    });

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    await host.start(['Goal stop cancel queue']);

    // Queue dev command
    const cmdRes = await host.command('dev', 'Pending dev command');
    expect(cmdRes.ok).toBe(true);

    const qBefore = store.listQueue(10);
    expect(qBefore.find((q) => q.id === cmdRes.id)?.status).toBe('queued');

    // Call stop()
    host.stop();

    const qAfter = store.listQueue(10);
    expect(qAfter.find((q) => q.id === cmdRes.id)?.status).toBe('cancelled');

    sessionGate.resolve();
  });

  it('command("pm", text) mở phiên với mục tiêu text', async () => {
    const mockRunner: Runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      output: 'ok',
      lastMessage: 'ok',
    });

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const res = await host.command('pm', 'Lệnh PM mở phiên');
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    const latest = store.getLatestSession(undefined, repoDir);
    expect(latest).toBeDefined();
    const session = store.getSession(latest!.id);
    expect(session?.goals).toEqual(['Lệnh PM mở phiên']);
  });

  it('command("qc", text) khi rảnh → chạy lượt trực tiếp, ghi lastMessage vào log_file', async () => {
    let calledPrompt = '';
    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, prompt, _cwd, _logFile) => {
        calledPrompt = prompt;
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'QC verification output',
          lastMessage: 'VERDICT: ALL TESTS PASS',
        };
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const res = await host.command('qc', 'Kiểm tra module auth');
    expect(res.ok).toBe(true);
    expect(res.id).toBeDefined();

    await new Promise((r) => setTimeout(r, 80));

    expect(calledPrompt).toContain('Kiểm tra module auth');
    const queue = store.listQueue(10);
    const item = queue.find((q) => q.id === res.id);
    expect(item?.status).toBe('done');

    // Check turns
    const latest = store.getLatestSession(undefined, repoDir);
    expect(latest).toBeDefined();
    const turns = store.listTurns(latest!.id);
    const qcTurn = turns.find((t) => t.task_id === `CMD-${res.id}`);
    expect(qcTurn).toBeDefined();
    expect(qcTurn?.seat).toBe('qc');
    expect(qcTurn?.result).toBe('ok');
    expect(qcTurn?.log_file).toBeDefined();

    // Check log_file content
    const content = readFileSync(qcTurn!.log_file!, 'utf8');
    expect(content).toContain('VERDICT: ALL TESTS PASS');
  });

  it('approve() resume phiên awaiting_approval', async () => {
    // Manually create an awaiting_approval session
    const sId = store.createSession(['Approve goal'], repoDir);
    store.setSessionStatus(sId, 'awaiting_approval');

    const mockRunner: Runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      output: 'ok',
      lastMessage: 'ok',
    });

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const approveRes = await host.approve();
    expect(approveRes.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 80));
    expect(host.busy()).toBe(false);
  });

  it('approve() khi không có phiên awaiting_approval → trả lỗi', async () => {
    const mockRunner: Runner = vi.fn();
    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const approveRes = await host.approve();
    expect(approveRes.ok).toBe(false);
    expect(approveRes.error).toBeDefined();
  });

  it('stop giữa lượt Dev trực tiếp → phiên giữ "stopped", không ghi đè thành "error"', async () => {
    const runnerStarted = deferred<void>();
    const runnerFinished = deferred<void>();
    let receivedSignal: AbortSignal | undefined;

    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, _prompt, _cwd, _logFile, opts) => {
        receivedSignal = opts?.signal;
        runnerStarted.resolve();
        return new Promise<TurnOutput>((resolve) => {
          opts?.signal?.addEventListener('abort', () => {
            setTimeout(() => {
              runnerFinished.resolve();
              resolve({
                exitCode: 1,
                timedOut: false,
                durationMs: 20,
                output: 'aborted',
                lastMessage: 'aborted',
              });
            }, 30);
          });
        });
      }
    );

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const cmdRes = await host.command('dev', 'Lệnh sửa lỗi trực tiếp');
    expect(cmdRes.ok).toBe(true);

    // Chờ runner bắt đầu chạy
    await runnerStarted.promise;
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);

    // Gọi stop() giữa lượt Dev trực tiếp
    const stopRes = await host.stop();
    expect(stopRes.ok).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);

    // Chờ runner kết thúc và host xử lý xong
    await runnerFinished.promise;
    await new Promise((r) => setTimeout(r, 60));

    // Phiên phải giữ 'stopped', không bị ghi đè thành 'error'
    const latest = store.getLatestSession(undefined, repoDir);
    expect(latest).toBeDefined();
    expect(latest?.status).toBe('stopped');

    // Lượt phải là error (aborted)
    const turns = store.listTurns(latest!.id);
    expect(turns.length).toBeGreaterThan(0);
    const lastTurn = turns[turns.length - 1];
    expect(lastTurn.result).toBe('error');
    expect(lastTurn.error).toMatch(/aborted/i);

    // Hàng đợi bị cancelled
    const q = store.listQueue(10);
    const item = q.find((it) => it.id === cmdRes.id);
    expect(item?.status).toBe('cancelled');

    // Khóa được nhả, host không busy
    expect(host.busy()).toBe(false);
    expect(existsSync(join(dataDir, 'btm.lock'))).toBe(false);
  });

  it('whenIdle() resolve ngay khi không có phiên/lượt chạy', async () => {
    const host = createHost({
      cfg,
      store,
      runner: vi.fn(),
      logDir,
      dataDir,
      env: {},
    });
    expect(host.busy()).toBe(false);
    let resolved = false;
    await host.whenIdle().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it('whenIdle() chờ lượt Dev chạy xong mới resolve', async () => {
    const runnerStarted = deferred<void>();
    const runnerFinished = deferred<void>();
    let isRunnerDone = false;

    const mockRunner: Runner = vi.fn().mockImplementation(async () => {
      runnerStarted.resolve();
      await runnerFinished.promise;
      isRunnerDone = true;
      return {
        exitCode: 0,
        timedOut: false,
        durationMs: 10,
        output: 'done',
        lastMessage: 'done',
      } as TurnOutput;
    });

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    await host.command('dev', 'Lệnh chạy Dev');
    await runnerStarted.promise;

    let idleResolved = false;
    const idlePromise = host.whenIdle().then(() => {
      idleResolved = true;
    });

    // Lúc này runner chưa xong, idlePromise chưa resolve
    await new Promise((r) => setTimeout(r, 20));
    expect(idleResolved).toBe(false);
    expect(isRunnerDone).toBe(false);

    // Cho runner xong
    runnerFinished.resolve();
    await idlePromise;
    expect(idleResolved).toBe(true);
    expect(isRunnerDone).toBe(true);
    expect(host.busy()).toBe(false);
  });

  it('whenIdle() chờ runner settle khi bị stop() giữa chừng', async () => {
    const runnerStarted = deferred<void>();
    let runnerAbortedAndSettled = false;

    const mockRunner: Runner = vi.fn().mockImplementation(async (_role, _agent, _prompt, _repo, _log, opts) => {
      runnerStarted.resolve();
      return new Promise<TurnOutput>((resolve) => {
        opts?.signal?.addEventListener('abort', () => {
          setTimeout(() => {
            runnerAbortedAndSettled = true;
            resolve({
              exitCode: 1,
              timedOut: false,
              durationMs: 50,
              output: 'aborted',
              lastMessage: 'aborted',
            });
          }, 50);
        });
      });
    });

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    await host.command('dev', 'Chạy lệnh chậm');
    await runnerStarted.promise;

    host.stop();

    let idleResolved = false;
    const idlePromise = host.whenIdle().then(() => {
      idleResolved = true;
    });

    // Ngay sau stop(), runner đang settle trong 50ms, idlePromise chưa resolve
    expect(idleResolved).toBe(false);
    expect(runnerAbortedAndSettled).toBe(false);

    await idlePromise;
    expect(idleResolved).toBe(true);
    expect(runnerAbortedAndSettled).toBe(true);
    expect(host.busy()).toBe(false);
  });
});
