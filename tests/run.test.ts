import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { runProcess, makeRunner } from '../src/runner/run.ts';
import { loadConfig } from '../src/config.ts';

describe('Runner Run', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'btm-run-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('runProcess', () => {
    it('captures output and exit code', async () => {
      const logFile = join(tmpDir, 'test.log');
      const res = await runProcess(['sh', '-c', 'echo hi; exit 3'], {
        cwd: tmpDir,
        timeoutMs: 5000,
        logFile,
      });

      expect(res.exitCode).toBe(3);
      expect(res.timedOut).toBe(false);
      expect(res.output).toContain('hi');
      expect(readFileSync(logFile, 'utf8')).toContain('hi');
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('kills whole process group on timeout', async () => {
      const logFile = join(tmpDir, 'timeout.log');
      const pidFile = join(tmpDir, 'child.pid');

      const res = await runProcess(
        ['sh', '-c', `sleep 30 & echo $! > "${pidFile}"; sleep 30`],
        {
          cwd: tmpDir,
          timeoutMs: 500,
          logFile,
        }
      );

      expect(res.timedOut).toBe(true);

      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(childPid)).toBe(true);

      // Verify the background child was killed along with the process group
      let isEsrch = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(childPid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch (err: any) {
          if (err.code === 'ESRCH') {
            isEsrch = true;
            break;
          }
          throw err;
        }
      }
      expect(isEsrch).toBe(true);
      expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/);
    });

    it('captures stdout and stderr together', async () => {
      const logFile = join(tmpDir, 'combined.log');
      const res = await runProcess(
        ['sh', '-c', 'echo standard-out; echo standard-err >&2; exit 0'],
        {
          cwd: tmpDir,
          timeoutMs: 5000,
          logFile,
        }
      );

      expect(res.exitCode).toBe(0);
      expect(res.output).toContain('standard-out');
      expect(res.output).toContain('standard-err');
      const logContent = readFileSync(logFile, 'utf8');
      expect(logContent).toContain('standard-out');
      expect(logContent).toContain('standard-err');
    });

    it('rejects when argv is empty', async () => {
      await expect(
        runProcess([], {
          cwd: tmpDir,
          timeoutMs: 1000,
          logFile: join(tmpDir, 'empty.log'),
        })
      ).rejects.toThrow(/argv must not be empty/);
    });

    it('always sends SIGKILL to entire process group after 5s even if parent process already closed', async () => {
      const logFile = join(tmpDir, 'sigkill.log');
      const pidFile = join(tmpDir, 'child_stubborn.pid');

      const res = await runProcess(
        [
          'sh',
          '-c',
          `sh -c 'trap "" TERM HUP; echo $$ > "${pidFile}"; sleep 30' >/dev/null 2>&1 & sleep 30`,
        ],
        {
          cwd: tmpDir,
          timeoutMs: 500,
          logFile,
        }
      );

      expect(res.timedOut).toBe(true);

      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(childPid)).toBe(true);

      try {
        let isEsrch = false;
        const deadline = Date.now() + 7000;
        while (Date.now() < deadline) {
          try {
            process.kill(childPid, 0);
            await new Promise((r) => setTimeout(r, 100));
          } catch (err: any) {
            if (err.code === 'ESRCH') {
              isEsrch = true;
              break;
            }
            throw err;
          }
        }
        expect(isEsrch).toBe(true);
        expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/);
      } finally {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {}
      }
    }, 15000);

    it('kills detached / new session descendant processes on timeout', async () => {
      const logFile = join(tmpDir, 'detached_timeout.log');
      const pidFile = join(tmpDir, 'detached_child.pid');

      const res = await runProcess(
        [
          'sh',
          '-c',
          `setsid sh -c 'trap "" TERM; echo $$ > "${pidFile}"; sleep 60' & sleep 60`,
        ],
        {
          cwd: tmpDir,
          timeoutMs: 500,
          logFile,
        }
      );

      expect(res.timedOut).toBe(true);

      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(childPid)).toBe(true);

      try {
        let isEsrch = false;
        const deadline = Date.now() + 7000;
        while (Date.now() < deadline) {
          try {
            process.kill(childPid, 0);
            await new Promise((r) => setTimeout(r, 100));
          } catch (err: any) {
            if (err.code === 'ESRCH') {
              isEsrch = true;
              break;
            }
            throw err;
          }
        }
        expect(isEsrch).toBe(true);
        expect(() => process.kill(childPid, 0)).toThrow(/ESRCH/);
      } finally {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {}
      }
    }, 15000);

    it('kills descendant processes when aborted via AbortSignal', async () => {
      const logFile = join(tmpDir, 'abort_test.log');
      const pidFile = join(tmpDir, 'abort_child.pid');
      const ac = new AbortController();

      const promise = runProcess(
        [
          'sh',
          '-c',
          `setsid sh -c 'trap "" TERM; echo $$ > "${pidFile}"; sleep 60' & sleep 60`,
        ],
        {
          cwd: tmpDir,
          timeoutMs: 30000,
          logFile,
          signal: ac.signal,
        }
      );

      // Wait a moment for the child process to start and write pidFile
      const deadlineWait = Date.now() + 3000;
      while (!existsSync(pidFile) && Date.now() < deadlineWait) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(pidFile)).toBe(true);
      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(childPid)).toBe(true);

      // Abort
      ac.abort();

      await expect(promise).rejects.toThrow(/aborted/i);

      let isEsrch = false;
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        try {
          process.kill(childPid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch (err: any) {
          if (err.code === 'ESRCH') {
            isEsrch = true;
            break;
          }
          throw err;
        }
      }
      expect(isEsrch).toBe(true);
    }, 15000);

    it('does not crash when logStream fails (e.g. logFile is a directory) and still resolves with correct output', async () => {
      const dirAsLogFile = join(tmpDir, 'dir-as-log');
      mkdirSync(dirAsLogFile, { recursive: true });

      const res = await runProcess(
        ['sh', '-c', 'echo "hello from stdout"; echo "hello from stderr" >&2; exit 0'],
        {
          cwd: tmpDir,
          timeoutMs: 5000,
          logFile: dirAsLogFile,
        }
      );

      expect(res.exitCode).toBe(0);
      expect(res.timedOut).toBe(false);
      expect(res.output).toContain('hello from stdout');
      expect(res.output).toContain('hello from stderr');
    });
  });

  describe('makeRunner', () => {
    it('creates runner and executes agent with fallback lastMessage', async () => {
      const cfg = loadConfig('btm.config.yaml');
      const binDir = join(tmpDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const logDir = join(tmpDir, 'logs');
      const mockAgy = join(binDir, 'agy');

      // Create a mock 'agy' executable in binDir
      writeFileSync(
        mockAgy,
        '#!/bin/sh\necho "agy executed successfully"\n'
      );
      chmodSync(mockAgy, 0o755);

      const runner = makeRunner(cfg);

      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath}`;
      try {
        const logFile = join(logDir, 'turn-1.log');
        const out = await runner('dev', 'jacky', 'Fix something', tmpDir, logFile);
        expect(out.exitCode).toBe(0);
        expect(out.timedOut).toBe(false);
        expect(out.output).toContain('agy executed successfully');
        expect(out.lastMessage).toContain('agy executed successfully');
        expect(readFileSync(logFile, 'utf8')).toContain('agy executed successfully');
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it('extracts lastMessage from outFile when produced', async () => {
      const cfg = loadConfig('btm.config.yaml');
      const binDir = join(tmpDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const logDir = join(tmpDir, 'logs');
      const mockCodex = join(binDir, 'codex');

      // Create a mock 'codex' executable that writes verdict to the -o file
      writeFileSync(
        mockCodex,
        `#!/bin/sh
# codex exec --sandbox read-only -o outFile prompt
outFile="$5"
echo '{"verdict":"pass","bugs":[],"fix":[],"confirm":[]}' > "$outFile"
echo "codex stdout line"
`
      );
      chmodSync(mockCodex, 0o755);

      const runner = makeRunner(cfg);

      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath}`;
      try {
        const logFile = join(logDir, 'turn-2.log');
        const out = await runner('qc', 'jenny', 'Verify task', tmpDir, logFile);
        expect(out.exitCode).toBe(0);
        expect(out.output).toContain('codex stdout line');
        expect(out.lastMessage).toContain('"verdict":"pass"');
        expect(readFileSync(logFile, 'utf8')).toContain('codex stdout line');
      } finally {
        process.env.PATH = originalPath;
      }
    });

    it('throws error for unknown agentId', async () => {
      const cfg = loadConfig('btm.config.yaml');
      const runner = makeRunner(cfg);
      await expect(
        runner('dev', 'nonexistent', 'prompt', tmpDir, join(tmpDir, 'turn-0.log'))
      ).rejects.toThrow(/Agent 'nonexistent' not found/);
    });

    it('resolves relative logFile before use and ensures outFile is absolute', async () => {
      const cfg = loadConfig('btm.config.yaml');
      const binDir = join(tmpDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const mockCodex = join(binDir, 'codex');

      const capturedArgsFile = join(tmpDir, 'captured_args.txt');
      writeFileSync(
        mockCodex,
        `#!/bin/sh
echo "$@" > "${capturedArgsFile}"
outFile="$5"
echo '{"verdict":"pass"}' > "$outFile"
`
      );
      chmodSync(mockCodex, 0o755);

      const relLogFile = 'test-relative-dir/turn-1.log';
      const expectedAbsLogDir = dirname(resolve(relLogFile));

      const runner = makeRunner(cfg);

      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath}`;
      try {
        const out = await runner('qc', 'jenny', 'Verify task', tmpDir, relLogFile);
        expect(out.exitCode).toBe(0);
        expect(out.lastMessage).toContain('"verdict":"pass"');

        const capturedArgs = readFileSync(capturedArgsFile, 'utf8');
        expect(capturedArgs).toContain(expectedAbsLogDir);
      } finally {
        process.env.PATH = originalPath;
        rmSync(expectedAbsLogDir, { recursive: true, force: true });
      }
    });

    it('makeRunner transmits images to buildArgv and includes -i absolutePath without fake commands', async () => {
      const cfg = loadConfig('btm.config.yaml');
      let capturedArgv: string[] = [];
      const mockRunProc = async (argv: string[], _o: any) => {
        capturedArgv = argv;
        return { exitCode: 0, timedOut: false, durationMs: 0, output: '' };
      };

      const runner = makeRunner(cfg, undefined, mockRunProc as any);
      const absImg = '/srv/agent-projects/btm/team/inbox/N-1.png';
      await runner('qc', 'jenny', 'Verify with screenshot', tmpDir, join(tmpDir, 'turn-1.log'), {
        images: [absImg],
      });

      expect(capturedArgv).toContain('-i');
      expect(capturedArgv).toContain(absImg);
    });
  });
});

describe('P4.5-T2: runner dưới worker', () => {
  it('argv bọc sudo wrapper theo user của agent; killAll trước/sau; đọc kết quả qua worker; sync lỗi → sync_failed', async () => {
    const base = loadConfig('btm.config.yaml');
    const cfg = { ...base, host: { ...base.host, worker_prefix: 'btm-', work_root: '/srv/btm-work' } };
    const seen: string[][] = [];
    const killed: string[] = [];
    let fail = false;
    const steps: string[] = [];
    let importOk = true;
    let syncOk = true;
    const iso = {
      sync: () => { steps.push('sync'); if (!syncOk) throw new Error('x'); },
      importTurn: () => { steps.push('import'); return importOk ? { ok: true as const, changed: true } : { ok: false as const, reason: 'bundle_invalid' as const }; },
      readOut: (_c: unknown, a: string) => `last:${a}`,
    };
    const proc = (async (argv: string[], o: { onKill?: () => void }) => {
      steps.push('run');
      seen.push(argv);
      expect(typeof o.onKill).toBe('function');
      if (fail) throw new Error('boom');
      return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' };
    }) as any;
    const runner = makeRunner(cfg, undefined, proc, (_c, a) => { killed.push(a); steps.push('kill'); }, iso);
    const dir = mkdtempSync(join(tmpdir(), 'btm-w-'));
    const path = require('node:path');
    const ws = path.join('/srv/btm-work', 'btm-jacky', path.basename(dir));
    const ok = await runner('dev', 'jacky', 'x', dir, join(dir, 'a.log'));
    expect(seen[0].slice(0, 7)).toEqual(['sudo', '-n', '-u', 'btm-jacky', '/usr/local/bin/btm-worker-exec', path.resolve(ws), '--']);
    expect(steps).toEqual(['kill', 'sync', 'run', 'kill', 'import', 'kill']);
    expect(killed).toEqual(['jacky', 'jacky', 'jacky']);
    expect(ok.lastMessage).toBe('last:jacky');
    importOk = false;
    const bad = await runner('dev', 'jacky', 'x', dir, join(dir, 'c.log'));
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain('bundle_invalid');
    steps.length = 0;
    syncOk = false;
    const noSync = await runner('dev', 'jacky', 'x', dir, join(dir, 'd.log'));
    expect(noSync.exitCode).toBe(1);
    expect(noSync.output).toContain('sync_failed');
    expect(steps).toEqual(['kill', 'sync', 'kill']);
    syncOk = true;
    killed.length = 0;
    fail = true;
    await expect(runner('dev', 'jacky', 'x', dir, join(dir, 'b.log'))).rejects.toThrow('boom');
    expect(killed.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('runProcess hết giờ → gọi onKill (giết tiến trình của user khác)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'btm-k-'));
    const onKill = vi.fn();
    const r = await runProcess(['sleep', '5'], { cwd: dir, timeoutMs: 100, logFile: join(dir, 'k.log'), onKill });
    expect(r.timedOut).toBe(true);
    expect(onKill).toHaveBeenCalledOnce();
    rmSync(dir, { recursive: true, force: true });
  });

});
