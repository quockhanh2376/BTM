import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initProject } from '../src/project/init.ts';
import { main } from '../src/cli.ts';
import { git, headSha, commitAll } from '../src/git.ts';
import * as gitModule from '../src/git.ts';
import * as storeModule from '../src/store/db.ts';
import { openStore } from '../src/store/db.ts';

describe('Project Init (initProject)', () => {
  let tmpRoot: string;
  const repoTemplates = join(process.cwd(), 'team', 'templates');

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'btm-init-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tạo đúng cây thư mục + 1 commit', () => {
    const projectPath = initProject(tmpRoot, 'moon-project', repoTemplates);

    expect(projectPath).toBe(join(tmpRoot, 'moon-project'));
    expect(existsSync(projectPath)).toBe(true);

    // Kiểm tra cây thư mục
    expect(existsSync(join(projectPath, 'team', 'tasks'))).toBe(true);
    expect(existsSync(join(projectPath, 'team', 'prompts'))).toBe(true);
    expect(existsSync(join(projectPath, 'team', 'reports'))).toBe(true);
    expect(existsSync(join(projectPath, 'team', 'templates'))).toBe(true);
    expect(existsSync(join(projectPath, 'team', 'memory'))).toBe(true);
    expect(existsSync(join(projectPath, 'docs'))).toBe(true);

    // Kiểm tra file
    const reportPath = join(projectPath, 'team', 'templates', 'report.md');
    expect(existsSync(reportPath)).toBe(true);
    const expectedReport = readFileSync(join(repoTemplates, 'report.md'), 'utf8');
    expect(readFileSync(reportPath, 'utf8')).toBe(expectedReport);

    const gitignorePath = join(projectPath, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);

    // Kiểm tra git repo và 1 commit
    const currentBranch = git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    expect(currentBranch).toBe('main');

    const log = git(projectPath, 'log', '--oneline').trim().split('\n');
    expect(log.length).toBe(1);
    expect(log[0]).toContain('init');
  });

  it('tên Go To Moon → throw', () => {
    expect(() => {
      initProject(tmpRoot, 'Go To Moon', repoTemplates);
    }).toThrow(/project name/i);
  });

  it('tên không hợp lệ khác (kí tự hoa, gạch dưới, rỗng, đường dẫn) → throw', () => {
    expect(() => initProject(tmpRoot, 'Moon', repoTemplates)).toThrow();
    expect(() => initProject(tmpRoot, 'moon_project', repoTemplates)).toThrow();
    expect(() => initProject(tmpRoot, 'moon/sub', repoTemplates)).toThrow();
    expect(() => initProject(tmpRoot, '', repoTemplates)).toThrow();
    expect(() => initProject(tmpRoot, '..', repoTemplates)).toThrow();
  });

  it('gọi lần 2 → throw', () => {
    initProject(tmpRoot, 'moon-project', repoTemplates);

    expect(() => {
      initProject(tmpRoot, 'moon-project', repoTemplates);
    }).toThrow(/already exists/i);
  });

  it('template không tồn tại → throw trước khi tạo thư mục', () => {
    const nonExistentTemplate = join(tmpRoot, 'no-such-templates');
    expect(() => {
      initProject(tmpRoot, 'moon-template-fail', nonExistentTemplate);
    }).toThrow(/template file not found/i);

    expect(existsSync(join(tmpRoot, 'moon-template-fail'))).toBe(false);
  });

  it('lỗi giữa chừng khi initProject → xóa thư mục vừa tạo', () => {
    const spy = vi.spyOn(gitModule, 'commitAll').mockImplementation(() => {
      throw new Error('Simulated git error');
    });

    try {
      expect(() => {
        initProject(tmpRoot, 'moon-cleanup-fail', repoTemplates);
      }).toThrow('Simulated git error');

      expect(existsSync(join(tmpRoot, 'moon-cleanup-fail'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('CLI (src/cli.ts)', () => {
  let tmpRoot: string;
  let dataDir: string;
  let configPath: string;
  const repoTemplates = join(process.cwd(), 'team', 'templates');

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'btm-cli-root-'));
    dataDir = mkdtempSync(join(tmpdir(), 'btm-cli-data-'));
    configPath = join(dataDir, 'test-btm.config.yaml');

    const cfgContent = `
host:
  run_as_user: agent
  projects_root: ${tmpRoot}
  dashboard:
    bind: 127.0.0.1
    port: 8080
  data_dir: ${dataDir}

session:
  max_goals: 3
  max_turns: 10
  max_turns_per_seat:
    pm: 5
    dev: 6
    qc: 4
  require_task_approval: true
  auto_schedule: false

turn:
  timeout_minutes:
    pm: 10
    dev: 25
    qc: 20
  max_parallel_agents: 1
  commit_before_dev_turn: true
  max_fix_rounds: 2

seats:
  pm: elon
  dev: jacky
  qc: jenny

agents:
  elon:
    tool: claude-code
    command: claude
    can_sit: [pm, qc]
  jacky:
    tool: antigravity-cli
    command: agy
    needs_pty: true
    can_sit: [dev]
  jenny:
    tool: codex-cli
    command: codex
    can_sit: [qc, dev]

rules:
  coder_cannot_qc_same_task: true
  auto_handoff_on_failure: false
  auto_switch_accounts: false

energy:
  read_on: [session_open, before_turn]
  cache_seconds: 180
  min_remaining_percent: 20
  reserve_turns_for_pm: 2

login:
  check_on: [session_open, before_turn]
  warn_expiry_days: 5
  forbidden_env:
    - ANTHROPIC_API_KEY
    - ANTHROPIC_AUTH_TOKEN
    - OPENAI_API_KEY
    - GEMINI_API_KEY
    - GOOGLE_API_KEY

gate:
  require_report_schema: true
  require_commit: true
  reject_empty_diff: true
  enforce_task_scope: true
  commands:
    build: ""
    lint: ""
    test: ""

git:
  protected_branch: main
  task_branch_prefix: task/
  merge_by: owner

plugins:
  project: [openspec]
  per_seat:
    pm: [openspec]
    dev: [openspec, ponytail]
    qc: [openspec, ponytail-review]
  later: [ui-ux-pro-max, superpowers]

runner:
  agy_allow_commands: [cat, ls, grep, head, tail, wc, git status, git diff, git log, git ls-files, npm test, npx vitest, npx tsc]
`;
    writeFileSync(configPath, cfgContent, 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('btm init <name> tạo project và đặt active_project trong SQLite', async () => {
    const exitCode = await main(['init', 'project-apollo', '--config', configPath]);
    expect(exitCode).toBe(0);

    const store = openStore(join(dataDir, 'btm.db'));
    const active = store.getActiveProject();
    expect(active).toBe(join(tmpRoot, 'project-apollo'));
    store.close();

    expect(existsSync(join(tmpRoot, 'project-apollo', 'team', 'tasks'))).toBe(true);
  });

  it('btm run khi chưa có active project thì in SessionOutcome refused và exit 2', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(['run', '--goal', 'Xây dựng module', '--config', configPath]);
    expect(exitCode).toBe(2);

    expect(consoleSpy).toHaveBeenCalled();
    const lastOutput = consoleSpy.mock.calls[0][0];
    const outcome = JSON.parse(lastOutput);
    expect(outcome.status).toBe('refused');
    consoleSpy.mockRestore();
  });

  it('btm run chạy session thành công, in JSON SessionOutcome và exit code tương ứng', async () => {
    await main(['init', 'project-gemini', '--config', configPath]);

    const fakeRunSession = vi.fn().mockResolvedValue({
      status: 'awaiting_approval',
      sessionId: 1,
      tasks: { 'T-001': 'pending' },
      notes: ['Awaiting task approval'],
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(
      ['run', '--goal', 'Mục tiêu 1', '--config', configPath],
      { runSession: fakeRunSession }
    );
    expect(exitCode).toBe(0);

    expect(fakeRunSession).toHaveBeenCalled();
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.status).toBe('awaiting_approval');
    expect(parsed.sessionId).toBe(1);
    consoleSpy.mockRestore();
  });

  it('btm run exit 1 khi status là needs_owner', async () => {
    await main(['init', 'project-mercury', '--config', configPath]);

    const fakeRunSession = vi.fn().mockResolvedValue({
      status: 'needs_owner',
      sessionId: 2,
      tasks: {},
      notes: ['Requires intervention'],
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(
      ['run', '--goal', 'Mục tiêu 2', '--config', configPath],
      { runSession: fakeRunSession }
    );
    expect(exitCode).toBe(1);
    consoleSpy.mockRestore();
  });

  it('btm status hiển thị active project, session gần nhất và số lượt theo ghế', async () => {
    await main(['init', 'project-saturn', '--config', configPath]);

    const store = openStore(join(dataDir, 'btm.db'));
    const sId = store.createSession(['Goal saturn']);
    store.startTurn(sId, 'pm', 'elon', null);
    store.startTurn(sId, 'dev', 'jacky', 'T-001');
    store.startTurn(sId, 'dev', 'jacky', 'T-001');
    store.startTurn(sId, 'qc', 'jenny', 'T-001');
    store.setSessionStatus(sId, 'done');
    store.close();

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(['status', '--config', configPath]);
    expect(exitCode).toBe(0);

    const loggedText = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(loggedText).toContain('project-saturn');
    expect(loggedText).toContain('1'); // session #1
    expect(loggedText).toContain('pm=1');
    expect(loggedText).toContain('dev=2');
    expect(loggedText).toContain('qc=1');
    consoleSpy.mockRestore();
  });

  it('parseArgs strict: --approved=false → lỗi exit 1', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(['run', '--approved=false', '--goal', 'Goal 1', '--config', configPath]);
    expect(exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  it('parseArgs strict: --goal thiếu giá trị → lỗi exit 1', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(['run', '--goal', '--config', configPath]);
    expect(exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  it('run không có --goal → in lỗi exit 1, không tạo session', async () => {
    await main(['init', 'project-no-goal', '--config', configPath]);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(['run', '--config', configPath]);
    expect(exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  it('run --approved không có --goal và không có session awaiting_approval → lỗi exit 1', async () => {
    await main(['init', 'project-resume-none', '--config', configPath]);
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(['run', '--approved', '--config', configPath]);
    expect(exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  it('run --approved không có --goal và có session awaiting_approval → resume session mới nhất', async () => {
    await main(['init', 'project-resume-ok', '--config', configPath]);
    const projectPath = join(tmpRoot, 'project-resume-ok');
    const store = openStore(join(dataDir, 'btm.db'));
    const s1 = store.createSession(['Goal 1'], projectPath);
    store.setSessionStatus(s1, 'done');
    const s2 = store.createSession(['Goal 2'], projectPath);
    store.setSessionStatus(s2, 'awaiting_approval');
    store.close();

    const fakeResumeSession = vi.fn().mockResolvedValue({
      status: 'done',
      sessionId: s2,
      tasks: { 'T-001': 'passed' },
      notes: [],
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(
      ['run', '--approved', '--config', configPath],
      { resumeSession: fakeResumeSession }
    );
    expect(exitCode).toBe(0);
    expect(fakeResumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ repo: join(tmpRoot, 'project-resume-ok') }),
      s2
    );
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.status).toBe('done');
    expect(parsed.sessionId).toBe(s2);
    consoleSpy.mockRestore();
  });

  it('A chờ duyệt, active là B → run --approved báo lỗi exit 1, session A vẫn awaiting_approval', async () => {
    await main(['init', 'project-a', '--config', configPath]);
    const projectAPath = join(tmpRoot, 'project-a');

    const store = openStore(join(dataDir, 'btm.db'));
    const sessionA = store.createSession(['Goal A'], projectAPath);
    store.setSessionStatus(sessionA, 'awaiting_approval');
    store.close();

    await main(['init', 'project-b', '--config', configPath]);

    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(['run', '--approved', '--config', configPath]);

    expect(exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalled();
    consoleErrSpy.mockRestore();

    const verifyStore = openStore(join(dataDir, 'btm.db'));
    expect(verifyStore.getSession(sessionA)?.status).toBe('awaiting_approval');
    verifyStore.close();
  });

  it('checkForbiddenEnv trước tiên: init với env cấm → exit 2', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(
      ['init', 'project-env-fail', '--config', configPath],
      { ANTHROPIC_API_KEY: 'sk-ant-test' }
    );
    expect(exitCode).toBe(2);
    expect(existsSync(join(tmpRoot, 'project-env-fail'))).toBe(false);
    consoleErrSpy.mockRestore();
  });

  it('checkForbiddenEnv trước tiên: run với env cấm → exit 2, không tạo session', async () => {
    await main(['init', 'project-run-env', '--config', configPath]);
    const fakeRunSession = vi.fn();
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(
      ['run', '--goal', 'Test goal', '--config', configPath],
      { OPENAI_API_KEY: 'sk-test' },
      { runSession: fakeRunSession }
    );
    expect(exitCode).toBe(2);
    expect(fakeRunSession).not.toHaveBeenCalled();
    consoleErrSpy.mockRestore();
  });

  it('checkForbiddenEnv trước tiên: status với env cấm → exit 2', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(
      ['status', '--config', configPath],
      { GEMINI_API_KEY: 'gemini-key' }
    );
    expect(exitCode).toBe(2);
    consoleErrSpy.mockRestore();
  });

  it('store.close() được gọi trong finally khi session run throw error', async () => {
    await main(['init', 'project-finally', '--config', configPath]);
    let closeCalled = false;
    const origOpenStore = storeModule.openStore;
    const openStoreSpy = vi.spyOn(storeModule, 'openStore').mockImplementation((path: string) => {
      const store = origOpenStore(path);
      const origClose = store.close.bind(store);
      store.close = () => {
        closeCalled = true;
        origClose();
      };
      return store;
    });

    const throwingRunSession = vi.fn().mockRejectedValue(new Error('Unexpected session crash'));
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(
      ['run', '--goal', 'Crash goal', '--config', configPath],
      {},
      { runSession: throwingRunSession }
    );
    expect(exitCode).toBe(1);
    expect(closeCalled).toBe(true);
    consoleErrSpy.mockRestore();
    openStoreSpy.mockRestore();
  });

  it('btm run bị abort bởi AbortController → endTurn error, session status stopped, exit 130', async () => {
    await main(['init', 'project-abort-test', '--config', configPath]);
    const projectPath = join(tmpRoot, 'project-abort-test');

    const ac = new AbortController();

    const fakeRunSession = vi.fn().mockImplementation(async (d: any) => {
      const sessionId = d.store.createSession(['Abort goal'], projectPath);
      const turnId = d.store.startTurn(sessionId, 'dev', 'jacky', 'T-001');
      ac.abort();
      await new Promise((r) => setTimeout(r, 20));
      return {
        status: 'stopped',
        sessionId,
        tasks: {},
        notes: ['aborted'],
      };
    });

    const exitCode = await main(
      ['run', '--goal', 'Abort goal', '--config', configPath],
      { runSession: fakeRunSession, abortController: ac }
    );

    expect(exitCode).toBe(130);

    const store = openStore(join(dataDir, 'btm.db'));
    const session = store.getLatestSession(undefined, projectPath);
    expect(session?.status).toBe('stopped');

    const db = new Database(join(dataDir, 'btm.db'));
    const turns = db.prepare('SELECT result, error FROM turns WHERE session_id = ?').all(session?.id) as any[];
    db.close();
    store.close();

    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].result).toBe('error');
  });

  it('btm run khóa liên tiến trình: khi lock tồn tại và pid còn sống → in lỗi, exit 1', async () => {
    await main(['init', 'project-lock-alive', '--config', configPath]);
    const lockPath = join(dataDir, 'btm.lock');
    // Ghi PID của tiến trình hiện tại (chắc chắn còn sống)
    writeFileSync(lockPath, String(process.pid));

    const fakeRunSession = vi.fn();
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(
      ['run', '--goal', 'Goal lock alive', '--config', configPath],
      { runSession: fakeRunSession }
    );
    expect(exitCode).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringMatching(/btm.*running|process.*running/i));
    expect(fakeRunSession).not.toHaveBeenCalled();
    consoleErrSpy.mockRestore();

    // Lock file vẫn còn nguyên
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('btm run khóa liên tiến trình: khi lock tồn tại nhưng pid đã chết → ghi đè và xóa trong finally', async () => {
    await main(['init', 'project-lock-dead', '--config', configPath]);
    const lockPath = join(dataDir, 'btm.lock');
    // PID giả định không tồn tại (chết)
    writeFileSync(lockPath, '99999999');

    const fakeRunSession = vi.fn().mockImplementation(async () => {
      // Trong khi session đang chạy, btm.lock phải chứa PID của process hiện tại
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
      return {
        status: 'done',
        sessionId: 1,
        tasks: {},
        notes: [],
      };
    });

    const exitCode = await main(
      ['run', '--goal', 'Goal lock dead', '--config', configPath],
      { runSession: fakeRunSession }
    );
    expect(exitCode).toBe(0);

    // Luôn xóa trong finally
    expect(existsSync(lockPath)).toBe(false);
  });

  it('btm run khóa liên tiến trình: test hai lần lấy khóa liên tiếp', async () => {
    await main(['init', 'project-lock-two-times', '--config', configPath]);
    const lockPath = join(dataDir, 'btm.lock');

    const fakeRunSession = vi.fn().mockResolvedValue({
      status: 'done',
      sessionId: 1,
      tasks: {},
      notes: [],
    });

    // Lần 1
    const exitCode1 = await main(
      ['run', '--goal', 'Goal 1', '--config', configPath],
      { runSession: fakeRunSession }
    );
    expect(exitCode1).toBe(0);
    expect(existsSync(lockPath)).toBe(false);

    // Lần 2
    const exitCode2 = await main(
      ['run', '--goal', 'Goal 2', '--config', configPath],
      { runSession: fakeRunSession }
    );
    expect(exitCode2).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });
});
