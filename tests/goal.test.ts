import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo } from './helpers.ts';
import { git, headSha } from '../src/git.ts';
import { openStore, type Store } from '../src/store/db.ts';
import { approveGoal } from '../src/ticket/goal.ts';
import { acquireLock, main } from '../src/cli.ts';
import type { Config } from '../src/config.ts';

const AUTHOR = ['-c', 'user.name=test', '-c', 'user.email=test@btm.local'];

function makeTestConfig(dataDir: string, opts?: { auditSeat?: string }): Config {
  return {
    host: {
      run_as_user: 'agent',
      projects_root: tmpdir(),
      dashboard: {
        bind: '127.0.0.1',
        port: 8080,
      },
      data_dir: dataDir,
      ssh_hint: 'test@host',
    },
    session: {
      max_goals: 3,
      max_turns: 10,
      max_turns_per_seat: {
        pm: 5,
        dev: 6,
        qc: 4,
        audit: 4,
      },
      require_task_approval: false,
      auto_schedule: false,
    },
    turn: {
      timeout_minutes: {
        pm: 10,
        dev: 25,
        qc: 20,
        audit: 20,
      },
      max_parallel_agents: 1,
      commit_before_dev_turn: true,
      max_fix_rounds: 2,
    },
    seats: {
      pm: 'elon',
      dev: 'jacky',
      qc: 'jenny',
      audit: opts?.auditSeat ?? '',
    },
    agents: {
      elon: { tool: 'claude-code', command: 'claude', can_sit: ['pm'] },
      jacky: { tool: 'antigravity-cli', command: 'agy', can_sit: ['dev'] },
      jenny: { tool: 'claude-code', command: 'claude', can_sit: ['qc'] },
      ...(opts?.auditSeat
        ? { [opts.auditSeat]: { tool: 'claude-code' as const, command: 'claude', can_sit: ['audit' as const] } }
        : {}),
    },
    rules: {
      coder_cannot_qc_same_task: true,
      auto_handoff_on_failure: true,
      auto_switch_accounts: false,
    },
    energy: {
      read_on: ['before_turn'],
      cache_seconds: 60,
      min_remaining_percent: 10,
      reserve_turns_for_pm: 1,
    },
    login: {
      check_on: ['before_turn'],
      warn_expiry_days: 7,
      forbidden_env: ['ANTHROPIC_API_KEY'],
    },
    gate: {
      require_report_schema: true,
      require_commit: true,
      reject_empty_diff: true,
      enforce_task_scope: true,
      commands: {
        build: 'npm run build',
        lint: 'npm run lint',
        test: 'npm test',
      },
    },
    git: {
      protected_branch: 'main',
      task_branch_prefix: 'task/',
      merge_by: 'owner',
    },
    plugins: {
      project: [],
      per_seat: {
        pm: [],
        dev: [],
        qc: [],
        audit: [],
      },
      later: [],
    },
    runner: {
      agy_allow_commands: ['git status', 'git diff'],
    },
  };
}

describe('approveGoal', () => {
  let dataDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'btm-goal-data-'));
    dbPath = join(dataDir, 'btm.db');
    store = openStore(dbPath);
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it('goal không tồn tại (G9) → not_ready', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir);

    const res = approveGoal(store, repo, cfg, 9);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not_ready');
      expect(res.message).toMatch(/Goal G9 not found/i);
    }
  });

  it('goal in_progress → not_ready kèm state hiện tại', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir);
    const created = store.createGoal(repo, 'Dang phat trien');
    store.setGoalState(repo, created.n, 'in_progress', 'core');

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not_ready');
      expect(res.message).toContain('in_progress');
    }
  });

  it('goal open → not_ready kèm state hiện tại', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir);
    const created = store.createGoal(repo, 'Chua lam');

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not_ready');
      expect(res.message).toContain('open');
    }
  });

  it('có seats.audit mà goal ở qc_done → not_ready', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir, { auditSeat: 'kai' });
    const created = store.createGoal(repo, 'Can audit');
    store.setGoalState(repo, created.n, 'qc_done', 'core');

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not_ready');
      expect(res.message).toContain('qc_done');
      expect(res.message).toContain('audit_passed');
    }
  });

  it('có seats.audit và goal audit_passed → approved và merged, sha merge commit hợp lệ', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir, { auditSeat: 'kai' });
    const created = store.createGoal(repo, 'Tinh nang moi');

    // Tạo nhánh goal và 1 commit
    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'feature.txt'), 'done');
    git(repo, 'add', 'feature.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0001: add feature'], { cwd: repo });

    store.setGoalState(repo, created.n, 'audit_passed', 'kai');

    const initialHead = headSha(repo);
    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sha).toBeDefined();
      expect(typeof res.sha).toBe('string');
      expect(res.sha.length).toBe(40);

      // Kiểm tra log của main có merge commit
      const mainLog = git(repo, 'log', 'main', '-n', '1', '--format=%s').trim();
      expect(mainLog).toBe(`G${created.n}: Tinh nang moi`);

      // Goal state trong SQLite chuyển thành merged
      const g = store.getGoal(repo, created.n);
      expect(g?.state).toBe('merged');

      // Nhánh goal không bị xoá
      const branches = git(repo, 'branch').trim();
      expect(branches).toContain(created.branch);
    }
  });

  it('không có seats.audit và goal qc_done → approved và merged', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir, { auditSeat: '' });
    const created = store.createGoal(repo, 'Khong can audit');

    // Tạo nhánh goal và 1 commit
    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'no-audit.txt'), 'hello');
    git(repo, 'add', 'no-audit.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0002: no audit'], { cwd: repo });

    store.setGoalState(repo, created.n, 'qc_done', 'jenny');

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const g = store.getGoal(repo, created.n);
      expect(g?.state).toBe('merged');

      const mainLog = git(repo, 'log', 'main', '-n', '1', '--format=%s').trim();
      expect(mainLog).toBe(`G${created.n}: Khong can audit`);
    }
  });

  it('không có seats.audit và goal audit_passed → approved và merged (nhận cả 2)', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir, { auditSeat: '' });
    const created = store.createGoal(repo, 'Da qua audit san');

    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'audit-pre.txt'), 'ok');
    git(repo, 'add', 'audit-pre.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0003: pre audited'], { cwd: repo });

    store.setGoalState(repo, created.n, 'audit_passed', 'kai');

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const g = store.getGoal(repo, created.n);
      expect(g?.state).toBe('merged');
    }
  });

  it('B2: nhánh goal đã đổi sau khi QC/audit (refs/heads/<branch> !== reviewed_sha) → reject not_ready', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir, { auditSeat: '' });
    const created = store.createGoal(repo, 'Kiem tra reviewed_sha');

    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'code.txt'), 'version 1');
    git(repo, 'add', 'code.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0001: v1'], { cwd: repo });
    const reviewedSha = headSha(repo);

    // Goal set qc_done với reviewed_sha
    store.setGoalState(repo, created.n, 'qc_done', 'jenny', 'qc pass', reviewedSha);

    // Ai đó commit thêm lên nhánh goal sau khi qc_done
    writeFileSync(join(repo, 'code.txt'), 'tampered after qc');
    git(repo, 'add', 'code.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'tamper commit'], { cwd: repo });

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('not_ready');
      expect(res.message).toBe('nhánh goal đã đổi sau khi QC/audit');
    }
  });

  it('FIX-E: goal qc_done không có reviewed_sha → reject not_ready, không merge theo tên nhánh', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir, { auditSeat: '' });
    const created = store.createGoal(repo, 'Thieu reviewed sha');

    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'code.txt'), 'unreviewed code');
    git(repo, 'add', 'code.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0001: unreviewed'], { cwd: repo });
    store.setGoalState(repo, created.n, 'qc_done', 'jenny', 'legacy row without sha', null);
    const mainBefore = git(repo, 'rev-parse', 'refs/heads/main').trim();

    const res = approveGoal(store, repo, cfg, created.n);

    expect(res).toEqual({
      ok: false,
      code: 'not_ready',
      message: 'goal chưa có commit đã QC/audit',
    });
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(mainBefore);
    expect(store.getGoal(repo, created.n)?.state).toBe('qc_done');
  });

  it('B2: merge bằng sha (reviewed_sha) thay vì branch name', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir, { auditSeat: '' });
    const created = store.createGoal(repo, 'Merge bang sha');

    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'code.txt'), 'v1');
    git(repo, 'add', 'code.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0001: v1'], { cwd: repo });
    const reviewedSha = headSha(repo);

    store.setGoalState(repo, created.n, 'qc_done', 'jenny', 'qc pass', reviewedSha);

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const g = store.getGoal(repo, created.n);
      expect(g?.state).toBe('merged');
      // Main merge commit parent thứ 2 phải chính là reviewedSha
      const parents = git(repo, 'log', '-1', '--format=%P', 'main').trim().split(/\s+/);
      expect(parents[1]).toBe(reviewedSha);
    }
  });

  it('khoá btm.lock đang bị giữ → busy, nhả khoá trong finally', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir);
    const created = store.createGoal(repo, 'Dang bi khoa');
    store.setGoalState(repo, created.n, 'qc_done', 'jenny');

    // Chiếm khoá trước
    const release = acquireLock(dataDir);
    expect(release).not.toBeNull();

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('busy');
      expect(res.message).toMatch(/lock held/i);
    }

    // Nhả khoá
    release?.();

    // Thử lại → có thể acquire lock và không bị busy nữa
    // (nhánh goal chưa có commit mới nhưng approveGoal sẽ xử lý)
    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'busy-fix.txt'), '1');
    git(repo, 'add', 'busy-fix.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0004: fix busy'], { cwd: repo });
    store.setGoalState(repo, created.n, 'qc_done', 'jenny', 'qc pass', headSha(repo));

    const res2 = approveGoal(store, repo, cfg, created.n);
    expect(res2.ok).toBe(true);
  });

  it('working tree bẩn (dirty) → dirty, không merge, không đổi trạng thái', () => {
    const repo = tmpRepo({ 'README.md': '# Repo' });
    const cfg = makeTestConfig(dataDir);
    const created = store.createGoal(repo, 'Working tree dirty');

    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'dirty-branch.txt'), 'clean commit');
    git(repo, 'add', 'dirty-branch.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0005: clean'], { cwd: repo });

    store.setGoalState(repo, created.n, 'qc_done', 'jenny');

    // Làm bẩn working tree
    writeFileSync(join(repo, 'dirty-untracked.txt'), 'uncommitted changes');

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('dirty');
      expect(res.message).toMatch(/dirty/i);
    }

    const g = store.getGoal(repo, created.n);
    expect(g?.state).toBe('qc_done');
  });

  it('merge conflict → git merge --abort, goal về state trước đó, code: conflict, main không đổi', () => {
    const repo = tmpRepo({ 'shared.txt': 'original line\n' });
    const cfg = makeTestConfig(dataDir);
    const created = store.createGoal(repo, 'Xung dot merge');

    // Tạo nhánh goal và sửa shared.txt
    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'shared.txt'), 'goal modified line\n');
    git(repo, 'add', 'shared.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0006: modify shared on goal'], { cwd: repo });

    // Về main và sửa cùng file shared.txt
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'shared.txt'), 'main modified line differently\n');
    git(repo, 'add', 'shared.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'main conflict commit'], { cwd: repo });

    const mainShaBefore = headSha(repo);

    store.setGoalState(repo, created.n, 'qc_done', 'jenny');

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('conflict');
    }

    // Main không bị đổi SHA
    const mainShaAfter = git(repo, 'rev-parse', 'main').trim();
    expect(mainShaAfter).toBe(mainShaBefore);

    // Goal state được rollback về qc_done
    const g = store.getGoal(repo, created.n);
    expect(g?.state).toBe('qc_done');

    // Working tree không còn ở trạng thái merging
    const status = git(repo, 'status', '--porcelain').trim();
    expect(status).toBe('');
  });

  it('nhánh hiện tại được trả lại sau cả ok lẫn conflict', () => {
    const repo = tmpRepo({ 'file.txt': 'init\n' });
    const cfg = makeTestConfig(dataDir);

    // Tạo nhánh riêng để đứng
    git(repo, 'checkout', '-b', 'user-work-branch');

    const created = store.createGoal(repo, 'Tra lai nhanh');
    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'g-file.txt'), 'goal file');
    git(repo, 'add', 'g-file.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0007: ok'], { cwd: repo });
    store.setGoalState(repo, created.n, 'qc_done', 'jenny');

    // Chuyển lại về user-work-branch trước khi gọi approveGoal
    git(repo, 'checkout', 'user-work-branch');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('user-work-branch');

    const resOk = approveGoal(store, repo, cfg, created.n);
    expect(resOk.ok).toBe(true);

    // Sau khi ok, vẫn ở user-work-branch
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('user-work-branch');

    // Bây giờ test conflict khi đang đứng ở user-work-branch
    const created2 = store.createGoal(repo, 'Xung dot nhanh');
    git(repo, 'checkout', '-b', created2.branch);
    writeFileSync(join(repo, 'conflict.txt'), 'version goal');
    git(repo, 'add', 'conflict.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0008: conflict goal'], { cwd: repo });
    store.setGoalState(repo, created2.n, 'qc_done', 'jenny');

    // Main có conflict.txt
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'conflict.txt'), 'version main');
    git(repo, 'add', 'conflict.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'conflict main'], { cwd: repo });

    // Về user-work-branch
    git(repo, 'checkout', 'user-work-branch');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('user-work-branch');

    const resConflict = approveGoal(store, repo, cfg, created2.n);
    expect(resConflict.ok).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('user-work-branch');
  });

  it('nhánh hiện tại là chính nhánh goal → sau ok lẫn conflict vẫn ở nhánh goal', () => {
    const repo = tmpRepo({ 'file.txt': 'init\n' });
    const cfg = makeTestConfig(dataDir);

    const created = store.createGoal(repo, 'Dung tai goal branch');
    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'g-on-branch.txt'), 'content');
    git(repo, 'add', 'g-on-branch.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0009: commit on branch'], { cwd: repo });
    store.setGoalState(repo, created.n, 'qc_done', 'jenny');

    // Đang đứng ở created.branch
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(created.branch);

    const res = approveGoal(store, repo, cfg, created.n);
    expect(res.ok).toBe(true);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(created.branch);
  });

  it('FIX-F C2: approveGoal so với protected_sha:<repo> đã ghim, lệch → từ chối protected_branch_moved, KHÔNG tự kéo main (anh chạy btm main accept); khi merge thành công thì cập nhật sha ghim mới', () => {
    const repo = tmpRepo({ 'file.txt': 'init\n' });
    const cfg = makeTestConfig(dataDir);
    const mainSha0 = git(repo, 'rev-parse', 'refs/heads/main').trim();
    store.setSetting(`protected_sha:${repo}`, mainSha0);

    const created = store.createGoal(repo, 'Goal check pinned sha');
    git(repo, 'checkout', '-b', created.branch);
    writeFileSync(join(repo, 'g-file.txt'), 'goal file');
    git(repo, 'add', 'g-file.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0001: feature'], { cwd: repo });
    const reviewedSha = headSha(repo);
    store.setGoalState(repo, created.n, 'qc_done', 'jenny', 'qc pass', reviewedSha);

    // Kẻ xấu dịch refs/heads/main sang commit khác trước khi approveGoal
    git(repo, 'update-ref', 'refs/heads/main', reviewedSha);
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(reviewedSha);

    const resTampered = approveGoal(store, repo, cfg, created.n);
    expect(resTampered).toEqual({
      ok: false,
      code: 'not_ready',
      message: 'protected_branch_moved',
    });
    // main giữ nguyên (không tự reset – có thể là việc của anh); anh đưa main về / ghim lại thủ công
    expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(reviewedSha);
    git(repo, 'update-ref', 'refs/heads/main', mainSha0);

    // Giờ main đã về đúng sha ghim → approveGoal thành công và cập nhật protected_sha:<repo>
    const resOk = approveGoal(store, repo, cfg, created.n);
    expect(resOk.ok).toBe(true);
    if (resOk.ok) {
      expect(store.getSetting(`protected_sha:${repo}`)).toBe(resOk.sha);
    }
  });
});

describe('CLI btm goal', () => {
  let tmpRoot: string;
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'btm-goal-cli-root-'));
    dataDir = mkdtempSync(join(tmpdir(), 'btm-goal-cli-data-'));
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
    audit: 4
  require_task_approval: false
  auto_schedule: false

turn:
  timeout_minutes:
    pm: 10
    dev: 25
    qc: 20
    audit: 20
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
    can_sit: [pm]
  jacky:
    tool: antigravity-cli
    command: agy
    can_sit: [dev]
  jenny:
    tool: claude-code
    command: claude
    can_sit: [qc]

rules:
  coder_cannot_qc_same_task: true
  auto_handoff_on_failure: true
  auto_switch_accounts: false

energy:
  read_on: [before_turn]
  cache_seconds: 60
  min_remaining_percent: 10
  reserve_turns_for_pm: 1

login:
  check_on: [before_turn]
  warn_expiry_days: 7
  forbidden_env: [ANTHROPIC_API_KEY]

gate:
  require_report_schema: true
  require_commit: true
  reject_empty_diff: true
  enforce_task_scope: true
  commands:
    build: npm run build
    lint: npm run lint
    test: npm test

git:
  protected_branch: main
  task_branch_prefix: task/
  merge_by: owner

plugins:
  project: []
  per_seat:
    pm: []
    dev: []
    qc: []
    audit: []
  later: []

runner:
  agy_allow_commands: [git status, git diff]
`;
    writeFileSync(configPath, cfgContent, 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('btm goal list in bảng G<n> · <state> · <passed>/<total> · <branch> của project active', async () => {
    // Khởi tạo project
    const initCode = await main(['init', 'project-goal-list', '--key', 'GTM', '--config', configPath]);
    expect(initCode).toBe(0);

    const projectPath = join(tmpRoot, 'project-goal-list');
    const store = openStore(join(dataDir, 'btm.db'));
    const g1 = store.createGoal(projectPath, 'Dang nhap Google');
    const g2 = store.createGoal(projectPath, 'Thanh toan Stripe');

    store.upsertTicket(projectPath, {
      id: 'GTM-0001',
      goal: 'G1',
      number: 1,
      of: 2,
      title: 'Nut login Google',
      type: 'feat',
      size: 'S',
      scope: ['src/login.ts'],
      acceptance: ['Login click ok'],
      done_when: 'Test pass',
      depends_on: [],
      from_audit: false,
    });
    store.setTicketState(projectPath, 'GTM-0001', 'passed', 'jenny', 'qc passed');

    store.upsertTicket(projectPath, {
      id: 'GTM-0002',
      goal: 'G1',
      number: 2,
      of: 2,
      title: 'Callback Google',
      type: 'feat',
      size: 'S',
      scope: ['src/callback.ts'],
      acceptance: ['Callback ok'],
      done_when: 'Test pass',
      depends_on: [],
      from_audit: false,
    });
    // GTM-0002 vẫn ở pending (0/2 passed)
    store.setGoalState(projectPath, g1.n, 'in_progress', 'elon');

    store.close();

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(['goal', 'list', '--config', configPath]);
    expect(exitCode).toBe(0);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain(`G1 · in_progress · 1/2 · ${g1.branch}`);
    expect(output).toContain(`G2 · open · 0/0 · ${g2.branch}`);
    consoleSpy.mockRestore();
  });

  it('btm goal approve G1 thành công → exit 0, in thông báo kèm sha', async () => {
    await main(['init', 'project-approve-cli', '--key', 'GTM', '--config', configPath]);
    const projectPath = join(tmpRoot, 'project-approve-cli');

    const store = openStore(join(dataDir, 'btm.db'));
    const g1 = store.createGoal(projectPath, 'Giao dien dang ky');

    git(projectPath, 'checkout', '-b', g1.branch);
    writeFileSync(join(projectPath, 'reg.txt'), 'register code');
    git(projectPath, 'add', 'reg.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0001: register UI'], { cwd: projectPath });

    store.setGoalState(projectPath, g1.n, 'qc_done', 'jenny');
    store.close();

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(['goal', 'approve', 'G1', '--config', configPath]);
    expect(exitCode).toBe(0);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toMatch(/Goal G1 approved and merged: [a-f0-9]{40}/i);
    consoleSpy.mockRestore();
  });

  it('btm goal approve 1 (dạng số không có G) cũng nhận', async () => {
    await main(['init', 'project-approve-num', '--key', 'GTM', '--config', configPath]);
    const projectPath = join(tmpRoot, 'project-approve-num');

    const store = openStore(join(dataDir, 'btm.db'));
    const g1 = store.createGoal(projectPath, 'Goal dang so');

    git(projectPath, 'checkout', '-b', g1.branch);
    writeFileSync(join(projectPath, 'num.txt'), 'num code');
    git(projectPath, 'add', 'num.txt');
    execFileSync('git', [...AUTHOR, 'commit', '-m', 'GTM-0001: num code'], { cwd: projectPath });

    store.setGoalState(projectPath, g1.n, 'qc_done', 'jenny');
    store.close();

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await main(['goal', 'approve', '1', '--config', configPath]);
    expect(exitCode).toBe(0);
    consoleSpy.mockRestore();
  });

  it('btm goal approve G9 không tồn tại → in lỗi, exit 1', async () => {
    await main(['init', 'project-approve-notfound', '--key', 'GTM', '--config', configPath]);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await main(['goal', 'approve', 'G9', '--config', configPath]);
    expect(exitCode).toBe(1);

    const output = errSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toMatch(/Cannot approve goal G9/i);
    expect(output).toMatch(/not_ready/i);
    errSpy.mockRestore();
  });

  it('btm goal approve thiếu tham số goal hoặc sai định dạng → in lỗi, exit 1', async () => {
    await main(['init', 'project-approve-bad-arg', '--key', 'GTM', '--config', configPath]);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exit1 = await main(['goal', 'approve', '--config', configPath]);
    expect(exit1).toBe(1);

    const exit2 = await main(['goal', 'approve', 'abc', '--config', configPath]);
    expect(exit2).toBe(1);

    const exit3 = await main(['goal', 'invalid-sub', '--config', configPath]);
    expect(exit3).toBe(1);

    errSpy.mockRestore();
  });

  it('btm goal khi chưa có active project → in lỗi, exit 1', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitList = await main(['goal', 'list', '--config', configPath]);
    expect(exitList).toBe(1);

    const exitApprove = await main(['goal', 'approve', 'G1', '--config', configPath]);
    expect(exitApprove).toBe(1);

    errSpy.mockRestore();
  });
});
