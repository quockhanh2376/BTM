import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/store/db.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { createHost as realCreateHost } from '../src/server/host.ts';
import { tmpRepo } from './helpers.ts';
import type { Runner, TurnOutput } from '../src/runner/run.ts';
import { directPrompt } from '../src/core/prompts.ts';
import { snapshotTurn } from '../src/core/guard.ts';
import { acquireLock } from '../src/cli.ts';
import { git, headSha } from '../src/git.ts';
import * as gitModule from '../src/git.ts';

// Test không gọi CLI thật để đọc Energy/đăng nhập (Plan 3 Global Constraints): mặc định monitor giả luôn OK.
// Test nào cần monitor riêng vẫn truyền `monitor` để ghi đè.
const okMonitor = { refresh: async () => {}, gate: () => ({ ok: true as const }) };
const createHost = (d: Parameters<typeof realCreateHost>[0]) =>
  realCreateHost({ monitor: okMonitor as any, ...d });

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
      'team/project.yaml': 'key: GTM\n',
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

  it('P6-T2: phiên dừng vì usage_limit_hit → host tự Tiếp tục, tối đa 2 lần/phiên; lý do khác thì không', async () => {
    const sid = store.createSession(['G'], repoDir);
    store.setSessionStatus(sid, 'needs_owner');
    const runSession = vi.fn(async () => ({ status: 'needs_owner', sessionId: sid, tasks: {}, notes: ['usage_limit_hit:jacky'] }));
    const resumeSession = vi.fn(async () => ({ status: 'needs_owner', sessionId: sid, tasks: {}, notes: ['usage_limit_hit:jenny'] }));
    const host = createHost({ cfg, store, runner: vi.fn() as any, logDir, dataDir, env: {}, runSession: runSession as any, resumeSession: resumeSession as any });
    expect((await host.start(['Goal 1'])).ok).toBe(true);
    for (let i = 0; i < 40 && (host.busy() || resumeSession.mock.calls.length < 2); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 100));
    expect(resumeSession).toHaveBeenCalledTimes(2); // lần 3 không tự chạy nữa
    expect(host.busy()).toBe(false);
  });

  it('start hai lần liền → lần 2 error ("Session running")', async () => {
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
    expect(res2.error).toMatch(/session running/i);

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
    expect(res.error).toBe('Session running');
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

  it('1) stop() rồi start() liền trên cùng host → start() trả về {ok:false, error:"Stopping"} không chạy chồng, chỉ nhả khóa sau khi settle', async () => {
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
    expect(startRes2.error).toBe('Stopping');

    // Runner must NOT have been called for startRes2
    expect(runnerCallCount).toBe(1);
    expect(host.busy()).toBe(true);

    // Wait until runner promise settles
    await runnerFinished.promise;
    await new Promise((r) => setTimeout(r, 80));

    expect(host.busy()).toBe(false);
    expect(existsSync(join(dataDir, 'btm.lock'))).toBe(false);
  });

  it('2) stop() khi khóa do process khác giữ → trả về {ok:false, error:"Session started from terminal – stop it with Ctrl-C"} và không sửa DB', async () => {
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
    expect(res.error).toBe('Session started from terminal – stop it with Ctrl-C');

    // DB must not be modified
    const session = store.getSession(sId);
    expect(session?.status).toBe('running');

    const queue = store.listQueue(10);
    expect(queue.find((q) => q.id === qId)?.status).toBe('queued');
  });

  it('3) khóa ngoài → command() tạo queued; nhả khóa → tick() chạy nó', async () => {
    git(repoDir, 'checkout', '-b', 'goal/G1-task');
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
    git(repoDir, 'checkout', '-b', 'goal/G1-prompt');
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
    git(repoDir, 'checkout', '-b', 'goal/G1-status');
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
    expect(resEmpty.error).toBe('Command must be 1–2000 characters');

    const resSpaces = await host.command('pm', '    ');
    expect(resSpaces.ok).toBe(false);
    expect(resSpaces.error).toBe('Command must be 1–2000 characters');

    const resTooLong = await host.command('pm', 'x'.repeat(2001));
    expect(resTooLong.ok).toBe(false);
    expect(resTooLong.error).toBe('Command must be 1–2000 characters');

    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('8) dev trực tiếp commit với message "cmd <id>: <60 ký tự đầu>"', async () => {
    git(repoDir, 'checkout', '-b', 'goal/G1-sample');
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

    const expectedMsg = `G1: cmd ${cmdRes.id}: ${textLong.slice(0, 60)}`;
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
    expect(session?.goals).toEqual(['1']);
    expect(store.getGoal(repoDir, 1)?.title).toBe('Lệnh PM mở phiên');
  });

  it('command("qc", text) khi rảnh → chạy lượt trực tiếp, ghi lastMessage vào log_file', async () => {
    git(repoDir, 'checkout', '-b', 'goal/G1-qc');
    let calledPrompt = '';
    const qcDone = deferred<string>();
    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, prompt, _cwd, _logFile) => {
        calledPrompt = prompt;
        qcDone.resolve(prompt);
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

    await qcDone.promise;
    await host.whenIdle();

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

  it('stop() khi phiên của project active đang awaiting_approval → đặt "stopped", approve sau đó báo không có phiên chờ duyệt', async () => {
    const sId = store.createSession(['Plan awaiting goal'], repoDir);
    store.setSessionStatus(sId, 'awaiting_approval');

    const host = createHost({
      cfg,
      store,
      runner: vi.fn(),
      logDir,
      dataDir,
      env: {},
    });

    expect(host.busy()).toBe(false);

    // Gọi stop()
    const stopRes = await host.stop();
    expect(stopRes.ok).toBe(true);

    // Phiên của active project phải được đặt thành 'stopped'
    const session = store.getSession(sId);
    expect(session?.status).toBe('stopped');

    // approve sau đó báo lỗi không có phiên chờ duyệt
    const approveRes = await host.approve();
    expect(approveRes.ok).toBe(false);
    expect(approveRes.error).toMatch(/no session awaiting approval/i);
  });

  it('khi isStopping: command() trả {ok:false,error:"Đang dừng"} và tick() không chạy gì', async () => {
    const runnerStarted = deferred<void>();
    const runnerFinished = deferred<void>();

    let callCount = 0;
    const mockRunner: Runner = vi.fn().mockImplementation(
      async (_seat, _agent, _prompt, _cwd, _logFile, opts) => {
        callCount++;
        if (callCount === 1) {
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
              }, 50);
            });
          });
        }
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

    git(repoDir, 'checkout', '-b', 'goal/G1-stopping');
    await host.command('dev', 'Lệnh đầu tiên');
    await runnerStarted.promise;

    // Bắt đầu stop()
    const stopRes = await host.stop();
    expect(stopRes.ok).toBe(true);

    // Trong khi đang dừng (isStopping = true)
    const cmdDevRes = await host.command('dev', 'Lệnh trong khi dừng');
    expect(cmdDevRes).toEqual({ ok: false, error: 'Stopping' });

    const cmdPmRes = await host.command('pm', 'Lệnh PM trong khi dừng');
    expect(cmdPmRes).toEqual({ ok: false, error: 'Stopping' });

    // Đưa 1 item vào hàng đợi bằng tay qua store để kiểm tra tick() không chạy
    const manualQueueId = store.enqueue('qc', 'Manual queued item');
    await host.tick();
    const queuedItem = store.listQueue(10).find((q) => q.id === manualQueueId);
    expect(queuedItem?.status).toBe('queued');

    // Chờ hoàn tất stop
    await runnerFinished.promise;
    await host.whenIdle();
  });

  it('lượt trực tiếp KHÔNG dùng lại phiên awaiting_approval; tạo phiên riêng 1 lượt', async () => {
    // Tạo 1 phiên awaiting_approval của active project
    const awaitingSessionId = store.createSession(['Planning goals'], repoDir);
    store.setSessionStatus(awaitingSessionId, 'awaiting_approval');

    const mockRunner: Runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      durationMs: 15,
      output: 'done',
      lastMessage: 'done',
    });

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    git(repoDir, 'checkout', '-b', 'goal/G1-awaiting');
    const cmdRes = await host.command('dev', 'Lệnh trực tiếp độc lập');
    expect(cmdRes.ok).toBe(true);

    await host.whenIdle();

    // 1. Phiên awaiting_approval cũ vẫn giữ nguyên trạng thái awaiting_approval
    const awaitingSession = store.getSession(awaitingSessionId);
    expect(awaitingSession?.status).toBe('awaiting_approval');
    const awaitingTurns = store.listTurns(awaitingSessionId);
    expect(awaitingTurns.length).toBe(0);

    // 2. Lượt trực tiếp tạo phiên riêng biệt (id khác)
    const latestSession = store.getLatestSession(undefined, repoDir);
    expect(latestSession).toBeDefined();
    expect(latestSession?.id).not.toBe(awaitingSessionId);
    expect(latestSession?.status).toBe('done');

    // 3. Phiên riêng chỉ có 1 lượt
    const turns = store.listTurns(latestSession!.id);
    expect(turns.length).toBe(1);
    expect(turns[0].task_id).toBe(`CMD-${cmdRes.id}`);
  });

  it('dev trực tiếp: tree bẩn → từ chối dirty_tree, item cancelled, turn error, không gọi runner', async () => {
    git(repoDir, 'checkout', '-b', 'goal/G1-dirty');
    // Tạo working tree bẩn trong repo
    writeFileSync(join(repoDir, 'dirty.txt'), 'dirty content before cmd');

    const mockRunner: Runner = vi.fn();

    const host = createHost({
      cfg,
      store,
      runner: mockRunner,
      logDir,
      dataDir,
      env: {},
    });

    const cmdRes = await host.command('dev', 'Lệnh dev có dirty tree');
    expect(cmdRes.ok).toBe(true);

    await host.whenIdle();

    expect(mockRunner).not.toHaveBeenCalled();
    const queue = store.listQueue(10);
    const item = queue.find((q) => q.id === cmdRes.id);
    expect(item?.status).toBe('cancelled');

    const session = store.getLatestSession(undefined, repoDir);
    expect(session?.status).toBe('error');
    const turns = store.listTurns(session!.id);
    expect(turns[0].result).toBe('error');
    expect(turns[0].error).toBe('dirty_tree');
  });

  it('commitAll lỗi sau lượt trực tiếp → lượt "error", queue "done", phiên "error", trả lỗi lên log, không báo thành công', async () => {
    git(repoDir, 'checkout', '-b', 'goal/G1-commit-fail');
    const origCommitAll = gitModule.commitAll;
    const commitSpy = vi.spyOn(gitModule, 'commitAll').mockImplementation((repo, msg, author) => {
      if (msg.includes('cmd ')) {
        throw new Error('Simulated git commit error after runner');
      }
      return origCommitAll(repo, msg, author);
    });

    try {
      const mockRunner: Runner = vi.fn().mockImplementation(async (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'sample.txt'), 'code changes done');
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'code changes done',
          lastMessage: 'code changes done',
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

      const cmdRes = await host.command('dev', 'Lệnh gây lỗi commitAll');
      expect(cmdRes.ok).toBe(true);

      await host.whenIdle();

      // 1. Queue status phải là 'done'
      const q = store.listQueue(10);
      const qItem = q.find((it) => it.id === cmdRes.id);
      expect(qItem?.status).toBe('done');

      // 2. Lượt phải là 'error'
      const latestSession = store.getLatestSession(undefined, repoDir);
      expect(latestSession).toBeDefined();
      const turns = store.listTurns(latestSession!.id);
      expect(turns.length).toBe(1);
      const turn = turns[0];
      expect(turn.result).toBe('error');
      expect(turn.error).toMatch(/commit/i);

      // 3. Phiên phải là 'error' (không báo thành công)
      expect(latestSession?.status).toBe('error');

      // 4. Lỗi phải được ghi vào log của lượt
      expect(turn.log_file).toBeDefined();
      const logContent = readFileSync(turn.log_file!, 'utf8');
      expect(logContent).toMatch(/commit/i);
    } finally {
      commitSpy.mockRestore();
    }
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

    git(repoDir, 'checkout', '-b', 'goal/G1-stop-dev');
    const cmdRes = await host.command('dev', 'Lệnh sửa lỗi trực tiếp');
    expect(cmdRes.ok).toBe(true);

    // Chờ runner started chạy
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

    git(repoDir, 'checkout', '-b', 'goal/G1-idle');
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

    git(repoDir, 'checkout', '-b', 'goal/G1-settle');
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

  describe('P2-T8 B: Auto duyệt thẻ (host)', () => {
    it('mặc định đọc auto_approve = !cfg.session.require_task_approval và truyền vào runSession', async () => {
      let passedApproved: boolean | undefined;
      const mockRunSession = vi.fn().mockImplementation(async (_deps, _goals, opts) => {
        passedApproved = opts.approved;
        return { status: 'done', sessionId: 1, tasks: {}, notes: [] };
      });

      // Case 1: require_task_approval is true -> auto_approve default is false
      cfg.session.require_task_approval = true;
      const host1 = createHost({
        cfg,
        store,
        runner: vi.fn(),
        logDir,
        dataDir,
        env: {},
        runSession: mockRunSession,
      });

      await host1.start(['Goal 1']);
      await host1.whenIdle();
      expect(passedApproved).toBe(false);

      // Case 2: require_task_approval is false -> auto_approve default is true
      cfg.session.require_task_approval = false;
      const host2 = createHost({
        cfg,
        store,
        runner: vi.fn(),
        logDir,
        dataDir,
        env: {},
        runSession: mockRunSession,
      });

      await host2.start(['Goal 2']);
      await host2.whenIdle();
      expect(passedApproved).toBe(true);
    });

    it('host.setAutoApprove thay đổi setting trong DB và truyền approved vào runSession', async () => {
      let passedApproved: boolean | undefined;
      const mockRunSession = vi.fn().mockImplementation(async (_deps, _goals, opts) => {
        passedApproved = opts.approved;
        return { status: 'done', sessionId: 1, tasks: {}, notes: [] };
      });

      cfg.session.require_task_approval = true; // default would be false
      const host = createHost({
        cfg,
        store,
        runner: vi.fn(),
        logDir,
        dataDir,
        env: {},
        runSession: mockRunSession,
      });

      // Enable auto approve
      host.setAutoApprove(true);
      expect(store.getSetting('auto_approve')).toBe('true');

      await host.start(['Goal Auto Approve']);
      await host.whenIdle();
      expect(passedApproved).toBe(true);

      // Disable auto approve
      host.setAutoApprove(false);
      expect(store.getSetting('auto_approve')).toBe('false');

      await host.start(['Goal Manual Approve']);
      await host.whenIdle();
      expect(passedApproved).toBe(false);
    });

    it('command accepts team recipient and starts session with team note', async () => {
      let passedGoals: string[] | undefined;
      let passedOpts: any;
      const mockRunSession = vi.fn().mockImplementation(async (_deps, goals, opts) => {
        passedGoals = goals;
        passedOpts = opts;
        return { status: 'done', sessionId: 1, tasks: {}, notes: [] };
      });

      const host = createHost({
        cfg,
        store,
        runner: vi.fn(),
        logDir,
        dataDir,
        env: {},
        runSession: mockRunSession,
      });

      const res = await host.command('team' as any, 'Yêu cầu cả team làm việc này');
      expect(res.ok).toBe(true);
      await host.whenIdle();
      expect(passedGoals?.[0]).toContain('Team note N-1');
      expect(passedOpts.noteId).toBe(1);
    });

    it('deletes DB note and cleans up file if postNote fails on commit', async () => {
      const origCommitAll = gitModule.commitAll;
      const commitSpy = vi.spyOn(gitModule, 'commitAll').mockImplementation((repoArg, msg, author) => {
        if (msg.startsWith('inbox N-')) {
          throw new Error('Simulated git commit error on postNote');
        }
        return origCommitAll(repoArg, msg, author);
      });

      const host = createHost({
        cfg,
        store,
        runner: vi.fn(),
        logDir,
        dataDir,
        env: {},
      });

      try {
        const res = await host.command('team' as any, 'Ghi chú test commit fail');
        expect(res.ok).toBe(true);
        await host.whenIdle();

        // Verify DB note record is deleted
        const notes = store.listNotes(repoDir);
        expect(notes.length).toBe(0);

        // Verify md file is deleted
        const inboxDir = join(repoDir, 'team', 'inbox');
        expect(existsSync(join(inboxDir, 'N-1.md'))).toBe(false);
      } finally {
        commitSpy.mockRestore();
      }
    });

    it('deletes DB note if postNote fails on writing md', async () => {
      const inboxDir = join(repoDir, 'team', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, 'N-1.md'), 'pre-existing file');

      const host = createHost({
        cfg,
        store,
        runner: vi.fn(),
        logDir,
        dataDir,
        env: {},
      });

      const res = await host.command('team' as any, 'Ghi chú test collision');
      expect(res.ok).toBe(true);
      await host.whenIdle();

      // Verify DB note record is deleted
      const notes = store.listNotes(repoDir);
      expect(notes.length).toBe(0);
    });

    it('lệnh trực tiếp Dev/QC gọi refresh([agent]) và gate(agent); khi gate không ok -> không gọi runner, lượt và phiên error với reason', async () => {
      const mockRunner = vi.fn();
      const mockRefresh = vi.fn().mockResolvedValue(undefined);
      const mockGate = vi.fn().mockReturnValue({
        ok: false,
        reason: 'energy:5h còn 10%, hồi lúc 19:57',
      });

      const fakeMonitor = {
        refresh: mockRefresh,
        gate: mockGate,
      };

      const host = createHost({
        cfg,
        store,
        runner: mockRunner,
        logDir,
        dataDir,
        env: {},
        monitor: fakeMonitor as any,
      });

      store.setActiveProject(repoDir);
      git(repoDir, 'checkout', '-b', 'goal/G1-gate');
      const res = await host.command('dev', 'Viết test mới');
      expect(res.ok).toBe(true);

      await host.whenIdle();

      expect(mockRefresh).toHaveBeenCalledWith(['jacky']);
      expect(mockGate).toHaveBeenCalledWith('jacky');
      expect(mockRunner).not.toHaveBeenCalled();

      const session = store.getLatestSession(undefined, repoDir);
      expect(session).toBeDefined();
      expect(session!.status).toBe('error');

      const turns = store.listTurns(session!.id);
      expect(turns.length).toBe(1);
      expect(turns[0].result).toBe('error');
      expect(turns[0].error).toBe('energy:5h còn 10%, hồi lúc 19:57');
    });

    it('Task 5: host.setSeat rejects __proto__, constructor, toString without throwing', () => {
      const host = createHost({
        cfg,
        store,
        runner: vi.fn(),
        logDir,
        dataDir,
        env: {},
      });

      for (const dangerous of ['__proto__', 'constructor', 'toString']) {
        const resSeat = host.setSeat(dangerous as any, 'jenny');
        expect(resSeat.ok).toBe(false);
        expect(resSeat.status).toBe(400);

        const resAgent = host.setSeat('dev', dangerous);
        expect(resAgent.ok).toBe(false);
        expect(resAgent.status).toBe(400);
      }
    });

    it('Task 5: luồng thật qua host - dừng needs_owner giữa thẻ returned, đổi ghế dev, resume có Bàn giao, QC không được là coder cũ', async () => {
      store.setActiveProject(repoDir);

      const customCfg: Config = {
        ...cfg,
        agents: {
          ...cfg.agents,
          jacky: {
            ...cfg.agents.jacky,
            can_sit: ['dev', 'qc'],
          },
        },
      };

      let devGateOk = true;
      let dev1Prompt = '';
      let dev2Prompt = '';
      let dev2Agent = '';
      let qcRanWithJacky = false;
      let qcRanWithElon = false;

      const mockRunner: Runner = vi.fn().mockImplementation(
        async (seat, agent, prompt, cwd) => {
          if (seat === 'pm') {
            mkdirSync(join(cwd, 'team', 'tickets'), { recursive: true });
            writeFileSync(
              join(cwd, 'team', 'tickets', 'GTM-0001.md'),
              `---
id: GTM-0001
goal: G1
number: 1
of: 1
title: Test handoff and resume
type: feat
size: S
scope:
  - src/app.ts
acceptance:
  - ok
done_when: ok
---
`
            );
            return { exitCode: 0, output: 'PM done' };
          }
          if (seat === 'dev') {
            if (agent === 'jacky') {
              dev1Prompt = prompt;
              mkdirSync(join(cwd, 'src'), { recursive: true });
              writeFileSync(join(cwd, 'src', 'app.ts'), 'code from jacky');
              mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
              writeFileSync(
                join(cwd, 'team', 'reports', 'GTM-0001-dev.md'),
                `GTM-0001 · G1#1/1 · jacky-Dev\n# Dev Report\n- Bug: không\n- Cần sửa: không\n- Cần xác nhận: OK\n`
              );
              // Gate check will fail for jacky on the 2nd dev turn
              devGateOk = false;
              return { exitCode: 0, output: 'Dev 1 done' };
            }
            if (agent === 'jenny') {
              dev2Agent = agent;
              dev2Prompt = prompt;
              mkdirSync(join(cwd, 'src'), { recursive: true });
              writeFileSync(join(cwd, 'src', 'app.ts'), 'code from jenny');
              writeFileSync(
                join(cwd, 'team', 'reports', 'GTM-0001-dev.md'),
                `GTM-0001 · G1#1/1 · jenny-Dev\n# Dev Report\n- Bug: không\n- Cần sửa: không\n- Cần xác nhận: OK\n`
              );
              return { exitCode: 0, output: 'Dev 2 done' };
            }
          }
          if (seat === 'qc') {
            if (agent === 'jacky') {
              qcRanWithJacky = true;
            }
            if (agent === 'elon') {
              qcRanWithElon = true;
              return {
                exitCode: 0,
                lastMessage: JSON.stringify({
                  ticket: 'GTM-0001',
                  goal: 'G1',
                  number: 1,
                  verdict: 'pass',
                  bugs: [],
                  fix: [],
                  confirm: ['ok'],
                }),
              };
            }
            // First QC run by jenny returns fail to put task in returned state
            return {
              exitCode: 0,
              lastMessage: JSON.stringify({
                ticket: 'GTM-0001',
                goal: 'G1',
                number: 1,
                verdict: 'fail',
                bugs: ['needs bugfix'],
                fix: ['fix it'],
                confirm: [],
              }),
            };
          }
          return { exitCode: 0 };
        }
      );

      const fakeMonitor = {
        refresh: vi.fn().mockResolvedValue(undefined),
        gate: (agent: string) => {
          if (agent === 'jacky' && !devGateOk) {
            return { ok: false, reason: 'jacky_blocked_in_returned' };
          }
          return { ok: true };
        },
      };

      // Initial seats: PM: elon, Dev: jacky, QC: jenny
      store.setSetting('seat:pm', 'elon');
      store.setSetting('seat:dev', 'jacky');
      store.setSetting('seat:qc', 'jenny');

      const host = createHost({
        cfg: customCfg,
        store,
        runner: mockRunner,
        logDir,
        dataDir,
        env: {},
        monitor: fakeMonitor as any,
      });

      host.setAutoApprove(true);
      const startRes = await host.start(['Handoff test goal']);
      expect(startRes.ok).toBe(true);

      await host.whenIdle();

      // Session stopped at needs_owner when jacky was blocked during returned card
      const session1 = store.getLatestSession(undefined, repoDir);
      expect(session1?.status).toBe('needs_owner');

      // The ticket state is 'returned'
      expect(store.getTicketState(repoDir, 'GTM-0001')?.state).toBe('returned');

      // Swap Dev seat to jenny
      const seatRes1 = host.setSeat('dev', 'jenny');
      expect(seatRes1.ok).toBe(true);

      // Swap QC seat to jacky (the old coder!) to verify Rule 8
      const seatRes2 = host.setSeat('qc', 'jacky');
      expect(seatRes2.ok).toBe(true);

      // Resume host: runner should be called with jenny, prompt has 'Bàn giao'
      const resumeRes1 = await (host as any).resume();
      expect(resumeRes1.ok).toBe(true);

      await host.whenIdle();

      expect(dev2Agent).toBe('jenny');
      expect(dev2Prompt).toContain('Bàn giao');

      // Since QC is jacky (who was coder for T-001), QC cannot be old coder
      expect(qcRanWithJacky).toBe(false);
      const session2 = store.getLatestSession(undefined, repoDir);
      expect(session2?.status).toBe('needs_owner');
      const failures = store.listHandoffFailures(session2!.id);
      expect(failures.some((f) => f.reason === 'coder_cannot_qc_same_task')).toBe(true);

      // Swap QC to elon (who never coded T-001) and resume
      const seatRes3 = host.setSeat('qc', 'elon');
      expect(seatRes3.ok).toBe(true);

      const resumeRes2 = await (host as any).resume();
      expect(resumeRes2.ok).toBe(true);

      await host.whenIdle();

      expect(qcRanWithElon).toBe(true);
      const session3 = store.getLatestSession(undefined, repoDir);
      expect(session3?.status).toBe('done');
    });
  });

  describe('P4-FIX-C: Lệnh trực tiếp từ dashboard đi qua guard', () => {
    it('đang ở main → lệnh dev bị từ chối direct_cmd_needs_goal_branch, main không đổi, không runner call', async () => {
      // repoDir đang ở main (mặc định của tmpRepo)
      const currentBranch = git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      expect(currentBranch).toBe('main');
      const mainHeadBefore = headSha(repoDir);

      const mockRunner: Runner = vi.fn();
      const host = createHost({
        cfg,
        store,
        runner: mockRunner,
        logDir,
        dataDir,
        env: {},
      });

      const res = await host.command('dev', 'Lệnh khi ở main');
      expect(res.ok).toBe(true);

      await host.tick();

      // 1. Không gọi runner
      expect(mockRunner).not.toHaveBeenCalled();

      // 2. Queue item bị cancelled
      const queue = store.listQueue(10);
      const item = queue.find((q) => q.id === res.id);
      expect(item?.status).toBe('cancelled');

      // 3. Turn và Session ghi nhận lỗi direct_cmd_needs_goal_branch
      const session = store.getLatestSession(undefined, repoDir);
      expect(session?.status).toBe('error');
      const turns = store.listTurns(session!.id);
      expect(turns.length).toBe(1);
      expect(turns[0].result).toBe('error');
      expect(turns[0].error).toBe('direct_cmd_needs_goal_branch');

      // 4. Main không đổi
      expect(headSha(repoDir)).toBe(mainHeadBefore);
    });

    it('FIX-E B4: dev trực tiếp bị huỷ khi ticket goal đang làm; qc trực tiếp vẫn được chạy', async () => {
      git(repoDir, 'checkout', '-b', 'goal/G2-my-feature');
      store.upsertTicket(repoDir, {
        id: 'GTM-0001',
        goal: 'G2',
        number: 1,
        of: 1,
        title: 'Ticket đang làm',
        type: 'feat',
        size: 'S',
        scope: ['sample.txt'],
        acceptance: ['ok'],
        done_when: 'done',
        depends_on: [],
        from_audit: false,
      });

      const mockRunner: Runner = vi.fn().mockResolvedValue({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: 'ok',
        lastMessage: 'ok',
      });
      const host = createHost({ cfg, store, runner: mockRunner, logDir, dataDir, env: {} });

      for (const state of ['in_dev', 'returned', 'awaiting_qc'] as const) {
        store.setTicketState(repoDir, 'GTM-0001', state, 'core', `state ${state}`);
        const res = await host.command('dev', `dev command in ${state}`);
        expect(res.ok).toBe(true);
        await host.tick();
        await host.whenIdle();

        expect(store.listQueue(20).find((q) => q.id === res.id)?.status).toBe('cancelled');
        const session = store.getLatestSession(undefined, repoDir)!;
        const turns = store.listTurns(session.id);
        expect(turns[0].error).toBe('direct_cmd_ticket_in_progress');
      }

      const qcRes = await host.command('qc', 'review ticket đang làm');
      expect(qcRes.ok).toBe(true);
      await host.tick();
      await host.whenIdle();

      expect(store.listQueue(20).find((q) => q.id === qcRes.id)?.status).toBe('done');
      expect(mockRunner).toHaveBeenCalledTimes(1);
    });

    it('FIX-E B6: processQueue lần đầu khôi phục snapshot tồn đọng, xoá setting và log một dòng', async () => {
      const mainBefore = git(repoDir, 'rev-parse', 'refs/heads/main').trim();
      git(repoDir, 'checkout', '-b', 'goal/G3-recovery');
      writeFileSync(join(repoDir, 'interrupted.txt'), 'partial');
      git(repoDir, 'add', 'interrupted.txt');
      git(repoDir, '-c', 'user.name=dev', '-c', 'user.email=dev@btm.local', 'commit', '-m', 'partial turn');

      snapshotTurn(repoDir, 'goal/G3-recovery', 'main', store, 'dev');
      git(repoDir, 'update-ref', 'refs/heads/main', headSha(repoDir));
      expect(git(repoDir, 'rev-parse', 'refs/heads/main').trim()).not.toBe(mainBefore);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const host = createHost({ cfg, store, runner: vi.fn(), logDir, dataDir, env: {} });
      await host.tick();

      expect(git(repoDir, 'rev-parse', 'refs/heads/main').trim()).not.toBe(mainBefore); // D4: không tự kéo main về khi phục hồi
      expect(store.getSetting(`turn_guard:${repoDir}`)).toBe('');
      expect(logSpy).toHaveBeenCalledWith('recovered_interrupted_turn');
    });

    it('D3: main đổi ngoài BTM (lệch sha ghim) → lệnh dev trực tiếp bị huỷ, không chạy agent, không kéo main về', async () => {
      const mainBefore = git(repoDir, 'rev-parse', 'refs/heads/main').trim();
      store.setSetting(`protected_sha:${repoDir}`, mainBefore);
      git(repoDir, 'checkout', '-b', 'goal/G2-d3');
      writeFileSync(join(repoDir, 'owner.txt'), 'owner merge\n');
      git(repoDir, 'add', 'owner.txt');
      git(repoDir, '-c', 'user.name=zon', '-c', 'user.email=zon@btm.local', 'commit', '-m', 'owner work');
      const ownerSha = headSha(repoDir);
      git(repoDir, 'update-ref', 'refs/heads/main', ownerSha);

      const mockRunner: Runner = vi.fn();
      const host = createHost({ cfg, store, runner: mockRunner, logDir, dataDir, env: {} });
      const res = await host.command('dev', 'sửa nhỏ');
      expect(res.ok).toBe(true);
      await host.tick();

      expect(mockRunner).not.toHaveBeenCalled();
      expect(store.listQueue(10).find((q) => q.id === res.id)?.status).toBe('cancelled');
      expect(git(repoDir, 'rev-parse', 'refs/heads/main').trim()).toBe(ownerSha);
    });

    it('đang ở nhánh goal → chạy, commit đúng prefix G<n>: cmd <id>: …', async () => {
      git(repoDir, 'checkout', '-b', 'goal/G2-my-feature');

      const text = 'Sửa logic tính toán số dư';
      const mockRunner: Runner = vi.fn().mockImplementation(async (_seat, _agent, _prompt, cwd) => {
        const storedSnapshot = JSON.parse(store.getSetting(`turn_guard:${repoDir}`) || 'null');
        expect(storedSnapshot?.seat).toBe('dev');
        writeFileSync(join(cwd, 'sample.txt'), 'dev modified on goal branch\n');
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'ok',
          lastMessage: 'ok',
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

      const res = await host.command('dev', text);
      expect(res.ok).toBe(true);

      await host.tick();

      expect(mockRunner).toHaveBeenCalled();
      const queue = store.listQueue(10);
      const item = queue.find((q) => q.id === res.id);
      expect(item?.status).toBe('done');

      const lastCommitMsg = git(repoDir, 'log', '-1', '--format=%s').trim();
      expect(lastCommitMsg).toBe(`G2: cmd ${res.id}: ${text}`);
      expect(store.getSetting(`turn_guard:${repoDir}`)).toBe('');
    });

    it('dev lệnh trực tiếp checkout main + commit → main được khôi phục, quay về nhánh goal', async () => {
      const mainHeadBefore = git(repoDir, 'rev-parse', 'main').trim();
      git(repoDir, 'checkout', '-b', 'goal/G1-feature');

      const mockRunner: Runner = vi.fn().mockImplementation(async (_seat, _agent, _prompt, cwd) => {
        // Dev nghịch ngợm: checkout main và commit
        git(cwd, 'checkout', 'main');
        writeFileSync(join(cwd, 'evil.txt'), 'evil content on main');
        git(cwd, 'add', '-A');
        git(cwd, '-c', 'user.name=dev', '-c', 'user.email=dev@btm.local', 'commit', '-m', 'evil commit on main');
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'evil done',
          lastMessage: 'evil done',
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

      const res = await host.command('dev', 'Lệnh dev phá main');
      expect(res.ok).toBe(true);

      await host.tick();

      // 1. Main được khôi phục về sha cũ
      const mainHeadAfter = git(repoDir, 'rev-parse', 'main').trim();
      expect(mainHeadAfter).toBe(mainHeadBefore);

      // 2. Đã quay lại nhánh goal
      const currentBranch = git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      expect(currentBranch).toBe('goal/G1-feature');

      // 3. Turn báo lỗi agent_modified_protected_branch
      const session = store.getLatestSession(undefined, repoDir);
      expect(session?.status).toBe('error');
      const turns = store.listTurns(session!.id);
      expect(turns[0].result).toBe('error');
      expect(turns[0].error).toBe('agent_modified_protected_branch');
    });

    it('qc lệnh trực tiếp sửa file → bị huỷ (guard reset --hard + clean), working tree sạch', async () => {
      git(repoDir, 'checkout', '-b', 'goal/G1-feature');
      const initialContent = readFileSync(join(repoDir, 'sample.txt'), 'utf8');

      const mockRunner: Runner = vi.fn().mockImplementation(async (_seat, _agent, _prompt, cwd) => {
        // QC sửa file trái phép
        writeFileSync(join(cwd, 'sample.txt'), 'qc tampered file');
        writeFileSync(join(cwd, 'qc_extra.txt'), 'extra file created by qc');
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: 'qc done',
          lastMessage: 'QC report',
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

      const res = await host.command('qc', 'Kiểm tra file');
      expect(res.ok).toBe(true);

      await host.tick();

      // 1. File đã sửa được hoàn trả nội dung cũ
      expect(readFileSync(join(repoDir, 'sample.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(initialContent.replace(/\r\n/g, '\n'));

      // 2. File tạo thêm bị xoá
      expect(existsSync(join(repoDir, 'qc_extra.txt'))).toBe(false);

      // 3. Working tree hoàn toàn sạch
      expect(git(repoDir, 'status', '--porcelain').trim()).toBe('');

      // 4. Turn báo lỗi qc_modified_repo
      const session = store.getLatestSession(undefined, repoDir);
      expect(session?.status).toBe('error');
      const turns = store.listTurns(session!.id);
      expect(turns[0].result).toBe('error');
      expect(turns[0].error).toBe('qc_modified_repo');
    });

    it('C3: lệnh Dev trực tiếp bị chặn khi goal có ticket chưa passed mà có base_sha (gồm blocked/failed)', async () => {
      git(repoDir, 'checkout', '-b', 'goal/G2-c3-feature');
      const baseSha = headSha(repoDir);
      store.upsertTicket(repoDir, {
        id: 'GTM-0001',
        goal: 'G2',
        number: 1,
        of: 1,
        title: 'Ticket bị blocked/failed',
        type: 'feat',
        size: 'S',
        scope: ['sample.txt'],
        acceptance: ['ok'],
        done_when: 'done',
        depends_on: [],
        from_audit: false,
      });

      const mockRunner: Runner = vi.fn().mockResolvedValue({
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        output: 'ok',
        lastMessage: 'ok',
      });
      const host = createHost({ cfg, store, runner: mockRunner, logDir, dataDir, env: {} });

      for (const state of ['blocked', 'failed'] as const) {
        store.setTicketState(repoDir, 'GTM-0001', state, 'core', `state ${state}`, 0, baseSha);
        const res = await host.command('dev', `dev command in ${state}`);
        expect(res.ok).toBe(true);
        await host.tick();
        await host.whenIdle();

        expect(store.listQueue(20).find((q) => q.id === res.id)?.status).toBe('cancelled');
        const session = store.getLatestSession(undefined, repoDir)!;
        const turns = store.listTurns(session.id);
        expect(turns[0].error).toBe('direct_cmd_ticket_in_progress');
      }
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('C4: lệnh Dev trực tiếp đụng team/tickets/ → khôi phục như ticket_tampered, không commit phần đó', async () => {
      git(repoDir, 'checkout', '-b', 'goal/G2-c4-tickets');
      mkdirSync(join(repoDir, 'team', 'tickets'), { recursive: true });
      const originalTicket = '---\nid: GTM-0001\ngoal: G2\nnumber: 1\nof: 1\ntitle: Original\ntype: feat\nsize: S\nscope: [sample.txt]\nacceptance: [ok]\ndone_when: ok\n---\n';
      writeFileSync(join(repoDir, 'team', 'tickets', 'GTM-0001.md'), originalTicket, 'utf8');
      gitModule.commitAll(repoDir, 'GTM-0001: PM ticket', { name: 'elon', email: 'elon@btm.local' });

      const mockRunner: Runner = vi.fn().mockImplementation(async (_seat, _agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'sample.txt'), 'legit direct dev change\n', 'utf8');
        writeFileSync(
          join(cwd, 'team', 'tickets', 'GTM-0001.md'),
          originalTicket.replace('scope: [sample.txt]', 'scope: [sample.txt, secret.txt]'),
          'utf8'
        );
        writeFileSync(join(cwd, 'team', 'tickets', 'GTM-0002.md'), 'rogue ticket\n', 'utf8');
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 5,
          output: 'done',
          lastMessage: 'done',
        };
      });

      const host = createHost({ cfg, store, runner: mockRunner, logDir, dataDir, env: {} });
      const res = await host.command('dev', 'Sửa sample nhưng lén sửa ticket');
      expect(res.ok).toBe(true);
      await host.tick();
      await host.whenIdle();

      expect(readFileSync(join(repoDir, 'team', 'tickets', 'GTM-0001.md'), 'utf8').replace(/\r\n/g, '\n')).toBe(
        originalTicket
      );
      expect(existsSync(join(repoDir, 'team', 'tickets', 'GTM-0002.md'))).toBe(false);
      expect(readFileSync(join(repoDir, 'sample.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
        'legit direct dev change\n'
      );
      expect(git(repoDir, 'diff', 'HEAD~1', 'HEAD', '--', 'team/tickets').trim()).toBe('');
    });

    it('C6: lock ngoài đang giữ → host không recoverInterruptedTurn và không xoá snapshot; chỉ recover sau khi giữ được lock', async () => {
      const mainBefore = git(repoDir, 'rev-parse', 'refs/heads/main').trim();
      git(repoDir, 'checkout', '-b', 'goal/G3-c6-lock');
      writeFileSync(join(repoDir, 'in-flight.txt'), 'cli turn running');
      git(repoDir, 'add', 'in-flight.txt');
      git(repoDir, '-c', 'user.name=dev', '-c', 'user.email=dev@btm.local', 'commit', '-m', 'cli turn');

      snapshotTurn(repoDir, 'goal/G3-c6-lock', 'main', store, 'dev');
      git(repoDir, 'update-ref', 'refs/heads/main', headSha(repoDir));

      // Giả lập CLI `btm run` đang giữ btm.lock
      const externalRelease = acquireLock(dataDir);
      expect(externalRelease).not.toBeNull();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const host = createHost({ cfg, store, runner: vi.fn(), logDir, dataDir, env: {} });

      await host.tick();
      // Khi lock ngoài đang giữ: KHÔNG được recover hay xoá snapshot
      expect(store.getSetting(`turn_guard:${repoDir}`)).not.toBe('');
      expect(git(repoDir, 'rev-parse', 'refs/heads/main').trim()).not.toBe(mainBefore);
      expect(logSpy).not.toHaveBeenCalledWith('recovered_interrupted_turn');

      // Nhả lock ngoài rồi tick lại → lúc này host giữ được lock và recover
      externalRelease!();
      await host.tick();

      expect(git(repoDir, 'rev-parse', 'refs/heads/main').trim()).not.toBe(mainBefore); // D4: không tự kéo main về khi phục hồi
      expect(store.getSetting(`turn_guard:${repoDir}`)).toBe('');
      expect(logSpy).toHaveBeenCalledWith('recovered_interrupted_turn');
      logSpy.mockRestore();
    });
  });
});
