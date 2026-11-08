import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, type Config, type Seat } from '../src/config.ts';
import { openStore, type Store } from '../src/store/db.ts';
import { tmpRepo } from './helpers.ts';
import * as gitModule from '../src/git.ts';
import { git, commitAll, headSha } from '../src/git.ts';
import {
  pmPrompt,
  devPrompt,
  qcPrompt,
} from '../src/core/prompts.ts';
import {
  runSession,
  resumeSession,
  type SessionOutcome,
  type SessionDeps,
} from '../src/core/session.ts';
import { createMonitor } from '../src/energy/monitor.ts';
import type { TaskCard } from '../src/task/card.ts';

interface HandlerOutput {
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  output?: string;
  lastMessage?: string;
}

type StepHandler = (
  seat: Seat,
  agentId: string,
  prompt: string,
  cwd: string,
  logFile?: string
) => void | HandlerOutput | Promise<void | HandlerOutput>;

function createFakeRunner(steps: StepHandler[]) {
  const calls: Array<{ seat: Seat; agentId: string; prompt: string; cwd: string; logFile?: string }> = [];
  let index = 0;
  const runner = async (seat: Seat, agentId: string, prompt: string, cwd: string, logFile?: string) => {
    calls.push({ seat, agentId, prompt, cwd, logFile });
    if (index >= steps.length) {
      throw new Error(`Unexpected runner call #${index + 1} (${seat}/${agentId})`);
    }
    const handler = steps[index++];
    const res = await handler(seat, agentId, prompt, cwd, logFile);
    return {
      exitCode: 0,
      timedOut: false,
      durationMs: 50,
      output: '',
      lastMessage: '',
      ...(res || {}),
    };
  };
  return { runner, calls };
}

function makeDeps(repo: string, customCfg?: Partial<Config>): { deps: SessionDeps; store: Store; cfg: Config } {
  const baseCfg = loadConfig('btm.config.yaml');
  const realRepo = realpathSync(repo);
  const cfg: Config = {
    ...baseCfg,
    host: {
      ...baseCfg.host,
      projects_root: dirname(realRepo),
    },
    ...customCfg,
  };
  const store = openStore(':memory:');
  const deps: SessionDeps = {
    cfg,
    store,
    runner: async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 0,
      output: '',
      lastMessage: '',
    }),
    repo,
    env: { ...process.env, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
    logDir: join(dirname(realRepo), 'logs'),
  };
  return { deps, store, cfg };
}

describe('Prompts', () => {
  it('pmPrompt is <= 6 lines, Vietnamese, mentions front matter YAML and quoting strings with ": ", forbids git commit and push, and instructs bare scope paths', () => {
    const prompt = pmPrompt(['Mục tiêu 1', 'Mục tiêu 2']);
    const lines = prompt.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(prompt).toContain('Mục tiêu 1');
    expect(prompt).toContain('front matter YAML hợp lệ');
    expect(prompt).toContain("': '");
    expect(prompt).toMatch(/cấm.*commit.*push/i);
    expect(prompt).toMatch(/đường dẫn trần.*không chú thích/i);

    // Requirements for Task 9d:
    expect(prompt).toContain('acceptance và done_when chỉ mô tả kết quả sản phẩm kiểm tra được');
    expect(prompt).toContain('KHÔNG ghi quy trình git (commit, push, git status, nhánh) vì Core tự lo');
  });

  it('devPrompt is <= 6 lines, Vietnamese, mentions reading task file with acceptance, reports path, fix notes, merges newlines, forbids git commit and push, and lists allowed commands with restrictions', () => {
    const card: TaskCard = {
      id: 'T-001',
      goal: 'Hiện thực\ntính năng',
      scope: ['src/a.ts\n', 'src/b.ts'],
      acceptance: ['chạy được'],
      done_when: 'test pass\n',
    };
    const allowCommands = ['cat', 'ls', 'grep', 'git status', 'npx vitest'];
    const promptWithNotes = devPrompt(card, ['Lỗi syntax', 'out_of_scope:other.ts'], allowCommands);
    const lines = promptWithNotes.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(promptWithNotes).toContain('T-001');
    expect(promptWithNotes).toContain('team/tasks/T-001.md');
    expect(promptWithNotes).toContain('acceptance');
    expect(promptWithNotes).toContain('team/reports/T-001-dev.md');
    expect(promptWithNotes).toContain('Lỗi syntax');
    expect(promptWithNotes).toContain('out_of_scope:other.ts');
    expect(promptWithNotes).toMatch(/cấm.*commit.*push/i);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('Hiện thực tính năng');
    expect(lines[1]).toContain('src/a.ts, src/b.ts');

    // Requirements for Task 9c:
    expect(promptWithNotes).toContain('cat, ls, grep, git status, npx vitest');
    expect(promptWithNotes).toContain('mỗi lệnh chạy riêng lẻ');
    expect(promptWithNotes).toContain('không nối &&/;/|');
    expect(promptWithNotes).toContain('không find/sed/rm');
    expect(promptWithNotes).toContain('đọc file bằng công cụ đọc file');

    const promptNoNotes = devPrompt(card, [], allowCommands);
    expect(promptNoNotes.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('qcPrompt is <= 6 lines, Vietnamese, mentions reading task file with acceptance, merges newlines, forbids git commit and push, with JSON at the end', () => {
    const card: TaskCard = {
      id: 'T-001',
      goal: 'Hiện thực\ntính năng',
      scope: ['src/a.ts\n', 'src/b.ts'],
      acceptance: ['chạy được'],
      done_when: 'test pass\n',
    };
    const prompt = qcPrompt(card, 'abc1234');
    const lines = prompt.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(prompt).toContain('T-001');
    expect(prompt).toContain('team/tasks/T-001.md');
    expect(prompt).toContain('acceptance');
    expect(prompt).toContain('abc1234');
    expect(prompt).toMatch(/cấm.*commit.*push/i);
    expect(lines[0]).toContain('Hiện thực tính năng');
    expect(lines[2]).toContain('src/a.ts, src/b.ts');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('JSON QcResult đặt trong khối ```json ở cuối');
    expect(lastLine).toContain('{"verdict":"pass"|"fail"');

    // Requirements for Task 9d:
    expect(prompt).toContain('Core tự commit sau mỗi lượt Dev nên có commit sau base là bình thường');
    expect(prompt).toContain('file trong team/reports/ luôn được phép');
    expect(prompt).toContain('bỏ qua mọi tiêu chí về git/commit');
    expect(prompt).toContain('chỉ chấm sản phẩm theo acceptance');
  });

  it('pmPrompt with notes instructs reading note and image and writing note: N-<id> in front matter', () => {
    const prompt = pmPrompt(['Xử lý ghi chú team N-1: Thêm nút'], [
      { notePath: 'team/inbox/N-1.md', imagePath: 'team/inbox/N-1.png', id: 'N-1' },
    ]);
    expect(prompt).toContain('team/inbox/N-1.md');
    expect(prompt).toContain('team/inbox/N-1.png');
    expect(prompt).toContain('note: N-1');
    expect(prompt).toContain('báo cáo ≤ 5 dòng');
  });

  it('devPrompt and qcPrompt with card having note include note path and image instructions', () => {
    const card: TaskCard = {
      id: 'T-001',
      goal: 'Thêm nút',
      scope: ['src/a.ts'],
      acceptance: ['nút xuất hiện'],
      done_when: 'test pass',
      note: 'N-1',
    };
    const devP = devPrompt(card, [], ['cat', 'ls']);
    expect(devP).toContain('Đọc team/inbox/N-1.md và ảnh đính kèm; làm/chấm theo ảnh');
    expect(devP).toContain('báo cáo ≤ 5 dòng');

    const qcP = qcPrompt(card, 'base123');
    expect(qcP).toContain('Đọc team/inbox/N-1.md và ảnh đính kèm; làm/chấm theo ảnh');
    expect(qcP).toContain('báo cáo ≤ 5 dòng');
  });
});

describe('Session Coordinator (runSession)', () => {
  it('happy path: PM writes T-001 -> Dev modifies scope + report -> QC passes', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      // PM
      (_seat, _agent, _prompt, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Add hello world
scope:
  - src/app.ts
acceptance:
  - prints hello
done_when: app exists
---
# T-001
`
        );
      },
      // Dev
      (_seat, _agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const hello = "world";\n');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'reports', 'T-001-dev.md'),
          `# Báo cáo Dev T-001
- Bug: không
- Cần sửa: không
- Cần xác nhận: OK
`
        );
      },
      // QC
      () => ({
        lastMessage: JSON.stringify({
          verdict: 'pass',
          bugs: [],
          fix: [],
          confirm: ['all good'],
        }),
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(outcome.sessionId).toBe(1);
    expect(outcome.tasks['T-001']).toBe('passed');
    expect(calls.length).toBe(3);
    expect(calls[0].seat).toBe('pm');
    expect(calls[1].seat).toBe('dev');
    expect(calls[2].seat).toBe('qc');

    expect(store.countTurns(1)).toBe(3);
    expect(store.countTurns(1, 'pm')).toBe(1);
    expect(store.countTurns(1, 'dev')).toBe(1);
    expect(store.countTurns(1, 'qc')).toBe(1);

    // 3 commits on session/1 (PM commit + Dev commit + QC commit)
    const log = git(repo, 'log', '--oneline', 'main..session/1').trim().split('\n');
    expect(log.length).toBe(3);
    expect(log[0]).toContain('T-001: qc pass');

    // QC report committed to team/reports/T-001-qc.json
    const qcReport = JSON.parse(
      readFileSync(join(repo, 'team', 'reports', 'T-001-qc.json'), 'utf8')
    );
    expect(qcReport.verdict).toBe('pass');

    store.close();
  });

  it('awaiting approval: approved: false stops after PM turn without calling Dev', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal 1
scope:
  - file.txt
acceptance:
  - ok
done_when: done
---
`
        );
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal 1'], { approved: false });

    expect(outcome.status).toBe('awaiting_approval');
    expect(outcome.sessionId).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].seat).toBe('pm');
    expect(store.countTurns(1)).toBe(1);

    store.close();
  });

  it('PM edits file outside team/tasks/ -> does not commit them, needs_owner (pm_out_of_scope)', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// original\n' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
        // PM unauthorized change outside team/tasks/
        writeFileSync(join(cwd, 'src', 'app.ts'), '// PM modified app.ts!\n');
        writeFileSync(join(cwd, 'evil.txt'), 'malicious\n');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal 1'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes).toContain('pm_out_of_scope');
    expect(calls.length).toBe(1);

    // Out-of-scope files must NOT be committed in any git commit
    const committedFiles = git(repo, 'log', '-1', '--name-only').trim().split('\n');
    expect(committedFiles).not.toContain('src/app.ts');
    expect(committedFiles).not.toContain('evil.txt');

    store.close();
  });

  it('QC modifies repo (dirty working tree or commit) -> QC fail lý do qc_modified_repo, không pass', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);
    deps.cfg.turn.max_fix_rounds = 0; // fail immediately on 1 QC failure

    const { runner } = createFakeRunner([
      // PM
      (_seat, _agent, _prompt, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Add hello world
scope:
  - src/app.ts
acceptance:
  - prints hello
done_when: app exists
---
`
        );
      },
      // Dev
      (_seat, _agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const hello = "world";\n');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'reports', 'T-001-dev.md'),
          `# Báo cáo Dev T-001
- Bug: không
- Cần sửa: không
- Cần xác nhận: OK
`
        );
      },
      // QC: returns pass BUT modifies repo (leaves dirty working tree)
      (_seat, _agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'tampered.ts'), 'qc modified this');
        return {
          lastMessage: JSON.stringify({
            verdict: 'pass',
            bugs: [],
            fix: [],
            confirm: [],
          }),
        };
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    // Must NOT pass! Must fail because qc_modified_repo
    expect(outcome.tasks['T-001']).toBe('failed');
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes[0]).toContain('qc_modified_repo');

    // Report team/reports/T-001-qc.json must exist and record qc_modified_repo
    const qcReportContent = JSON.parse(
      readFileSync(join(repo, 'team', 'reports', 'T-001-qc.json'), 'utf8')
    );
    expect(qcReportContent.verdict).toBe('fail');
    expect(qcReportContent.fix).toContain('qc_modified_repo');

    store.close();
  });

  it('gate reject then fix: round 1 Dev edits out of scope, round 2 fixes it -> passed', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const recordSpy = vi.spyOn(store, 'recordHandoffFailure');

    const { runner, calls } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Modify app
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev round 1: out of scope edit
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'outside.txt'), 'illegal');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // Dev round 2: fixes edit in scope
      (_s, _a, prompt, cwd) => {
        expect(prompt).toContain('out_of_scope:outside.txt');
        git(cwd, 'rm', 'outside.txt');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed');
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // QC
      () => ({
        lastMessage: JSON.stringify({
          verdict: 'pass',
          bugs: [],
          fix: [],
          confirm: [],
        }),
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Modify app'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(outcome.tasks['T-001']).toBe('passed');
    expect(calls.length).toBe(4);

    // Handoff failures recorded using session store
    expect(recordSpy).toHaveBeenCalledWith(1, 'T-001', 'out_of_scope:outside.txt');
    expect(store.countTurns(1, 'dev')).toBe(2);

    store.close();
  });

  it('fix rounds exhausted: QC fails 3 times with max_fix_rounds: 2 -> failed, needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      turn: {
        ...loadConfig('btm.config.yaml').turn,
        max_fix_rounds: 2,
      },
    });

    const { runner, calls } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Fix bug
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev 1
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev 1');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // QC 1 (fail 1)
      () => ({
        lastMessage: JSON.stringify({
          verdict: 'fail',
          bugs: ['bug 1'],
          fix: ['fix 1'],
          confirm: [],
        }),
      }),
      // Dev 2
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev 2');
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // QC 2 (fail 2)
      () => ({
        lastMessage: JSON.stringify({
          verdict: 'fail',
          bugs: ['bug 2'],
          fix: ['fix 2'],
          confirm: [],
        }),
      }),
      // Dev 3
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev 3');
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // QC 3 (fail 3) -> exceeds max_fix_rounds (2)
      () => ({
        lastMessage: JSON.stringify({
          verdict: 'fail',
          bugs: ['bug 3'],
          fix: ['fix 3'],
          confirm: [],
        }),
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Fix bug'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.tasks['T-001']).toBe('failed');
    expect(calls.length).toBe(7); // PM(1) + Dev(3) + QC(3)

    store.close();
  });

  it('out of turns: max_turns: 3 stops out_of_turns, runner not called 4th time', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      session: {
        ...loadConfig('btm.config.yaml').session,
        max_turns: 3,
      },
      energy: {
        ...loadConfig('btm.config.yaml').energy,
        reserve_turns_for_pm: 0,
      },
    });

    const { runner, calls } = createFakeRunner([
      // PM (turn 1)
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev (turn 2)
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), '2');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // QC (turn 3) - fail
      () => ({
        lastMessage: JSON.stringify({
          verdict: 'fail',
          bugs: ['still broken'],
          fix: [],
          confirm: [],
        }),
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('out_of_turns');
    expect(calls.length).toBe(3); // Turn 4 not called
    expect(store.countTurns(1)).toBe(3);

    store.close();
  });

  it('refused on API key in env', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);
    deps.env = { OPENAI_API_KEY: 'sk-test' };

    let runnerCalled = false;
    deps.runner = async () => {
      runnerCalled = true;
      return { exitCode: 0, timedOut: false, durationMs: 0, output: '', lastMessage: '' };
    };

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('refused');
    expect(outcome.sessionId).toBeNull();
    expect(runnerCalled).toBe(false);

    store.close();
  });

  it('refused when repo is outside projects_root', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);
    deps.cfg.host.projects_root = '/srv/nonexistent-projects-root';

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('refused');
    expect(outcome.sessionId).toBeNull();

    store.close();
  });

  it('refused when goals count is 0 or exceeds max_goals', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);

    const outcomeEmpty = await runSession(deps, [], { approved: true });
    expect(outcomeEmpty.status).toBe('refused');

    const outcomeTooMany = await runSession(deps, ['g1', 'g2', 'g3', 'g4'], { approved: true });
    expect(outcomeTooMany.status).toBe('refused');

    store.close();
  });

  it('timeout makes WIP commit: Dev timedOut: true -> WIP T-001 commit, needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev times out after modifying file
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'wip content');
        return {
          timedOut: true,
          exitCode: null,
          output: 'Agent timed out',
          lastMessage: '',
        };
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(calls.length).toBe(2);

    // Verify commit exists on session/1 with WIP T-001
    const lastCommitMsg = git(repo, 'log', '-1', '--pretty=%B', 'session/1').trim();
    expect(lastCommitMsg).toContain('WIP T-001');

    store.close();
  });

  it('invalid QC output: prose instead of JSON -> fail with qc_output_invalid', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev 1
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // QC 1 returns plain text
      () => ({
        lastMessage: 'Tôi thấy code trông khá ổn nhưng không có JSON.',
      }),
      // Dev 2 should receive note 'qc_output_invalid'
      (_s, _a, prompt, cwd) => {
        expect(prompt).toContain('qc_output_invalid');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev fixed');
      },
      // QC 2 returns pass
      () => ({
        lastMessage: JSON.stringify({
          verdict: 'pass',
          bugs: [],
          fix: [],
          confirm: [],
        }),
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(outcome.tasks['T-001']).toBe('passed');
    expect(calls.length).toBe(5);

    store.close();
  });

  it('Dev reports BLOCKED -> task blocked, needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev blocked
      () => ({
        output: 'Cannot proceed. BLOCKED: missing dependencies.',
        lastMessage: 'BLOCKED: missing dependencies.',
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.tasks['T-001']).toBe('blocked');

    store.close();
  });

  it('coder_cannot_qc_same_task: stops with needs_owner if QC is same agent as Dev', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      seats: {
        pm: 'elon',
        dev: 'jacky',
        qc: 'jacky', // Same agent
      },
      rules: {
        ...loadConfig('btm.config.yaml').rules,
        coder_cannot_qc_same_task: true,
      },
    });

    const { runner, calls } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev done');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(calls.length).toBe(2); // QC was NOT called

    store.close();
  });

  it('PM creates invalid card (CardError) -> needs_owner', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      // PM creates card with invalid scope containing '..'
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - ../outside.txt
acceptance:
  - ok
done_when: done
---
`
        );
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.sessionId).toBe(1);

    store.close();
  });

  it('hết lượt theo ghế: dev exceeds max_turns_per_seat.dev -> out_of_turns', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      session: {
        ...loadConfig('btm.config.yaml').session,
        max_turns_per_seat: { pm: 5, dev: 1, qc: 5 },
      },
    });

    const { runner, calls } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev 1: out of scope edit to trigger gate rejection
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'outside.txt'), 'bad');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('out_of_turns');
    expect(calls.length).toBe(2);
    expect(store.countTurns(1, 'dev')).toBe(1);

    store.close();
  });

  it('giữ lượt PM (reserve): reserve_turns_for_pm blocks non-PM from consuming reserved turns', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      session: {
        ...loadConfig('btm.config.yaml').session,
        max_turns: 2,
      },
      energy: {
        ...loadConfig('btm.config.yaml').energy,
        reserve_turns_for_pm: 1,
      },
    });

    const { runner, calls } = createFakeRunner([
      // PM (turn 1)
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('out_of_turns');
    expect(calls.length).toBe(1);
    expect(store.countTurns(1)).toBe(1);

    store.close();
  });

  it('đổi coder giữa vòng: coder_cannot_qc stops when QC matches ANY agent that coded the task', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      seats: {
        pm: 'elon',
        dev: 'alice',
        qc: 'alice', // QC is alice
      },
      rules: {
        ...loadConfig('btm.config.yaml').rules,
        coder_cannot_qc_same_task: true,
      },
    });

    const { runner, calls } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev 1 (alice): out of scope to trigger round 2
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'outside.txt'), 'bad');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        // Switch coder for next round to 'bob'
        deps.cfg.seats.dev = 'bob';
      },
      // Dev 2 (bob): fixes the problem
      (_s, _a, _p, cwd) => {
        git(cwd, 'rm', 'outside.txt');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed');
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    // Although Dev 2 was bob, Alice coded Round 1, and QC is Alice!
    expect(outcome.status).toBe('needs_owner');
    expect(calls.length).toBe(3); // PM + Dev 1 (alice) + Dev 2 (bob), QC was NOT called
    expect(outcome.notes[0]).toContain("who also coded task 'T-001'");

    store.close();
  });

  it('author commit = agent dev: commits created by Dev use Dev agent identity', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      seats: {
        pm: 'elon',
        dev: 'custom-dev',
        qc: 'jenny',
      },
    });

    const { runner } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'custom work');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
      },
      // QC
      () => ({
        lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });
    expect(outcome.status).toBe('done');

    const devAuthorLine = git(repo, 'log', '-1', '--format=%an <%ae>', 'session/1~1').trim();
    expect(devAuthorLine).toBe('custom-dev <custom-dev@btm.local>');
    const qcAuthorLine = git(repo, 'log', '-1', '--format=%an <%ae>', 'session/1').trim();
    expect(qcAuthorLine).toBe('jenny <jenny@btm.local>');

    store.close();
  });

  it('Dev không đổi gì → gate empty_diff, QC không được gọi (max_fix_rounds: 0)', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      turn: {
        ...loadConfig('btm.config.yaml').turn,
        max_fix_rounds: 0,
      },
    });
    const recordSpy = vi.spyOn(store, 'recordHandoffFailure');

    let qcCalled = false;
    const { runner } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev: does not change anything
      () => {},
      // QC should NEVER be called
      () => {
        qcCalled = true;
        return {
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        };
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });
    expect(outcome.status).toBe('needs_owner');
    expect(recordSpy).toHaveBeenCalledWith(1, 'T-001', 'empty_diff');
    expect(qcCalled).toBe(false);

    store.close();
  });

  it('Runner throw: dev runner throws -> endTurn("error"), commit WIP, needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const endTurnSpy = vi.spyOn(store, 'endTurn');

    const { runner } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev throws an unhandled error
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'crash wip');
        throw new Error('Agent process killed unexpectedly');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes[0]).toContain('Agent process killed unexpectedly');
    expect(endTurnSpy).toHaveBeenCalledWith(
      expect.any(Number),
      'error',
      'Agent process killed unexpectedly'
    );

    const lastCommitMsg = git(repo, 'log', '-1', '--pretty=%B', 'session/1').trim();
    expect(lastCommitMsg).toContain('WIP T-001');
    expect(lastCommitMsg).toContain('Agent process killed unexpectedly');

    store.close();
  });

  it('Lượt thành công chỉ khi exitCode===0 và !timedOut: non-zero exitCode triggers error turn and needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const endTurnSpy = vi.spyOn(store, 'endTurn');

    const { runner } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev returns exitCode: 127
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'wip');
        return {
          exitCode: 127,
          timedOut: false,
          output: 'command not found',
        };
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(endTurnSpy).toHaveBeenCalledWith(expect.any(Number), 'error', 'exit_127');

    const lastCommitMsg = git(repo, 'log', '-1', '--pretty=%B', 'session/1').trim();
    expect(lastCommitMsg).toContain('WIP T-001: exit_127');

    store.close();
  });

  it('Checkout nhánh và mọi bước nằm trong try/finally để luôn setSessionStatus', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo, {
      git: {
        ...loadConfig('btm.config.yaml').git,
        protected_branch: 'non-existent-base-branch',
      },
    });
    const setSessionStatusSpy = vi.spyOn(store, 'setSessionStatus');

    await expect(runSession(deps, ['Goal'], { approved: true })).rejects.toThrow();

    expect(setSessionStatusSpy).toHaveBeenCalledWith(1, 'needs_owner');

    store.close();
  });

  it('commitAll lỗi sau lượt → lượt đã có ended_at, session có status cuối', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const dbPath = join(repo, 'store.db');
    const customStore = openStore(dbPath);
    const { deps } = makeDeps(repo);
    deps.store.close();
    deps.store = customStore;

    const { runner } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev modifies file and creates index.lock so commitAll fails
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev done');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        writeFileSync(join(cwd, '.git', 'index.lock'), '');
      },
    ]);
    deps.runner = runner;

    // Should not throw, should return needs_owner
    const outcome = await runSession(deps, ['Goal'], { approved: true });
    expect(outcome.status).toBe('needs_owner');

    const directDb = new Database(dbPath);
    const turns = directDb.prepare('SELECT seat, started_at, ended_at, result FROM turns').all() as Array<{
      seat: string;
      started_at: string;
      ended_at: string | null;
      result: string | null;
    }>;
    const devTurn = turns.find((t) => t.seat === 'dev');
    expect(devTurn).toBeDefined();
    expect(devTurn!.ended_at).not.toBeNull();
    expect(typeof devTurn!.ended_at).toBe('string');

    const session = directDb.prepare('SELECT status, ended_at FROM sessions WHERE id = 1').get() as {
      status: string;
      ended_at: string | null;
    };
    expect(session.status).toBe('needs_owner');
    expect(session.ended_at).not.toBeNull();

    directDb.close();
    customStore.close();
  });

  it('runner trả exitCode:null, timedOut:false → lượt "error", needs_owner, QC không gọi', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const dbPath = join(repo, 'store.db');
    const customStore = openStore(dbPath);
    const { deps } = makeDeps(repo);
    deps.store.close();
    deps.store = customStore;

    let qcCalled = false;
    const { runner } = createFakeRunner([
      // PM
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tasks', 'T-001.md'),
          `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
        );
      },
      // Dev returns exitCode: null, timedOut: false (e.g. killed by signal)
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'wip');
        return {
          exitCode: null,
          timedOut: false,
          output: 'Killed by SIGKILL',
        };
      },
      // QC should NOT be called
      () => {
        qcCalled = true;
        return {
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        };
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(qcCalled).toBe(false);

    const directDb = new Database(dbPath);
    const turns = directDb.prepare('SELECT seat, started_at, ended_at, result FROM turns').all() as Array<{
      seat: string;
      started_at: string;
      ended_at: string | null;
      result: string | null;
    }>;
    const devTurn = turns.find((t) => t.seat === 'dev');
    expect(devTurn).toBeDefined();
    expect(devTurn!.result).toBe('error');
    expect(devTurn!.ended_at).not.toBeNull();

    const session = directDb.prepare('SELECT status, ended_at FROM sessions WHERE id = 1').get() as {
      status: string;
      ended_at: string | null;
    };
    expect(session.status).toBe('needs_owner');

    directDb.close();
    customStore.close();
  });

  describe('resumeSession', () => {
    it('chỉ cho session awaiting_approval: throw khi session khác awaiting_approval hoặc không tồn tại', async () => {
      const repo = tmpRepo({});
      const { deps, store } = makeDeps(repo);

      await expect(resumeSession(deps, 999)).rejects.toThrow(/awaiting_approval/);

      const sId = store.createSession(['Goal 1']);
      store.setSessionStatus(sId, 'done');
      await expect(resumeSession(deps, sId)).rejects.toThrow(/awaiting_approval/);

      store.close();
    });

    it('resumeSession từ chối session khác project mà KHÔNG đổi status của nó', async () => {
      const repoA = tmpRepo({});
      const repoB = tmpRepo({});
      const { deps: depsA, store } = makeDeps(repoA);
      const depsB: SessionDeps = {
        ...depsA,
        repo: repoB,
      };

      const sId = store.createSession(['Goal 1'], repoA);
      store.setSessionStatus(sId, 'awaiting_approval');

      await expect(resumeSession(depsB, sId)).rejects.toThrow(/belongs to project/i);

      // Status must not change
      expect(store.getSession(sId)?.status).toBe('awaiting_approval');

      store.close();
    });

    it('resumeSession checkout session/<id>, bỏ qua lượt PM (PM không gọi lần 2), chạy tiếp từ Dev', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'console.log("hello");' });
      const { deps, store } = makeDeps(repo);

      let pmCallCount = 0;
      let devCallCount = 0;
      let qcCallCount = 0;

      const { runner } = createFakeRunner([
        // 1. PM in runSession
        (_s, _a, _p, cwd) => {
          pmCallCount++;
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Add feature
scope: [src/app.ts]
acceptance:
  - app works
done_when: done
---
`
          );
        },
        // 2. Dev in resumeSession
        (_s, _a, _p, cwd) => {
          devCallCount++;
          writeFileSync(join(cwd, 'src', 'app.ts'), 'console.log("updated");');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // 3. QC in resumeSession
        () => {
          qcCallCount++;
          return {
            lastMessage: '{"verdict":"pass","bugs":[],"fix":[],"confirm":[]}',
          };
        },
      ]);
      deps.runner = runner;

      // First run pauses with awaiting_approval
      const pauseOutcome = await runSession(deps, ['Goal 1'], { approved: false });
      expect(pauseOutcome.status).toBe('awaiting_approval');
      expect(pauseOutcome.sessionId).toBe(1);
      expect(pmCallCount).toBe(1);
      expect(devCallCount).toBe(0);

      // Checkout main to test that resumeSession checks out session/<id>
      git(repo, 'checkout', 'main');

      // Now resume
      const resumeOutcome = await resumeSession(deps, 1);
      expect(resumeOutcome.status).toBe('done');
      expect(resumeOutcome.tasks['T-001']).toBe('passed');

      // PM must NOT be called a second time
      expect(pmCallCount).toBe(1);
      expect(devCallCount).toBe(1);
      expect(qcCallCount).toBe(1);

      // Verify branch is session/1
      const currentBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      expect(currentBranch).toBe('session/1');

      // Verify DB status
      expect(store.getLatestSession()?.status).toBe('done');

      store.close();
    });

    it('session passes cfg.runner.agy_allow_commands into devPrompt', async () => {
      const repo = tmpRepo({ 'src/app.ts': '1' });
      const customAllow = ['cat', 'git status', 'npx vitest'];
      const { deps, store } = makeDeps(repo, {
        runner: {
          ...loadConfig('btm.config.yaml').runner,
          agy_allow_commands: customAllow,
        },
      });

      let devPromptReceived = '';
      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev
        (_s, _a, prompt, cwd) => {
          devPromptReceived = prompt;
          writeFileSync(join(cwd, 'src', 'app.ts'), '2');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal'], { approved: true });
      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      expect(devPromptReceived).toContain('cat, git status, npx vitest');
      expect(devPromptReceived).toContain('mỗi lệnh chạy riêng lẻ');
      expect(devPromptReceived).toContain('không nối &&/;/|');
      expect(devPromptReceived).toContain('không find/sed/rm');
      expect(devPromptReceived).toContain('đọc file bằng công cụ đọc file');

      store.close();
    });

    it('Dev output containing auto-denied records handoff failure command_denied and adds fixNote for next round', async () => {
      const repo = tmpRepo({ 'src/app.ts': '1' });
      const { deps, store } = makeDeps(repo);
      const recordSpy = vi.spyOn(store, 'recordHandoffFailure');

      let devRound2Prompt = '';
      const { runner, calls } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev round 1: command auto-denied by agy headless
        () => ({
          exitCode: 0,
          output: 'tool bash: auto-denied command "find . -name *.ts"',
          lastMessage: 'auto-denied',
        }),
        // Dev round 2: receives fixNote and implements properly
        (_s, _a, prompt, cwd) => {
          devRound2Prompt = prompt;
          writeFileSync(join(cwd, 'src', 'app.ts'), '2');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal'], { approved: true });

      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      expect(outcome.tasks['T-001']).toBe('passed');
      expect(calls.length).toBe(4); // PM, Dev r1, Dev r2, QC

      expect(recordSpy).toHaveBeenCalledWith(1, 'T-001', 'command_denied');
      expect(devRound2Prompt).toContain('command_denied: chỉ dùng lệnh trong danh sách, mỗi lệnh riêng lẻ');

      store.close();
    });

    it('Dev output containing auto-denied with non-zero exit code is handled as command_denied fix round', async () => {
      const repo = tmpRepo({ 'src/app.ts': '1' });
      const { deps, store } = makeDeps(repo);
      const recordSpy = vi.spyOn(store, 'recordHandoffFailure');

      let devRound2Prompt = '';
      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev round 1: agy aborts on auto-denied with exitCode 1
        () => ({
          exitCode: 1,
          output: 'Error: auto-denied tool execution outside whitelist',
          lastMessage: 'Terminated',
        }),
        // Dev round 2: fixes
        (_s, _a, prompt, cwd) => {
          devRound2Prompt = prompt;
          writeFileSync(join(cwd, 'src', 'app.ts'), '2');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal'], { approved: true });

      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      expect(outcome.tasks['T-001']).toBe('passed');
      expect(recordSpy).toHaveBeenCalledWith(1, 'T-001', 'command_denied');
      expect(devRound2Prompt).toContain('command_denied: chỉ dùng lệnh trong danh sách, mỗi lệnh riêng lẻ');

      store.close();
    });
  });

  describe('Plan 2 Task 2: Session board states + per-turn logs', () => {
    it('happy path ghi đúng chuỗi pending → in_dev → awaiting_qc → passed', async () => {
      const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
      const { deps, store } = makeDeps(repo);

      const taskStateTransitions: Array<{ taskId: string; state: string; fixRounds: number }> = [];
      const origSetTaskState = store.setTaskState.bind(store);
      store.setTaskState = (sessionId, taskId, state, fixRounds) => {
        taskStateTransitions.push({ taskId, state, fixRounds });
        origSetTaskState(sessionId, taskId, state, fixRounds);
      };

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), '// dev\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'pass',
            bugs: [],
            fix: [],
            confirm: [],
          }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal 1'], { approved: true });
      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');

      expect(taskStateTransitions).toEqual([
        { taskId: 'T-001', state: 'pending', fixRounds: 0 },
        { taskId: 'T-001', state: 'in_dev', fixRounds: 0 },
        { taskId: 'T-001', state: 'awaiting_qc', fixRounds: 0 },
        { taskId: 'T-001', state: 'passed', fixRounds: 0 },
      ]);

      const finalStates = store.listTaskStates(outcome.sessionId!);
      expect(finalStates).toEqual([
        expect.objectContaining({
          task_id: 'T-001',
          state: 'passed',
          fix_rounds: 0,
        }),
      ]);

      store.close();
    });

    it('QC rớt một lần → có returned với fix_rounds: 1 rồi passed', async () => {
      const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
      const { deps, store } = makeDeps(repo);

      const taskStateTransitions: Array<{ taskId: string; state: string; fixRounds: number }> = [];
      const origSetTaskState = store.setTaskState.bind(store);
      store.setTaskState = (sessionId, taskId, state, fixRounds) => {
        taskStateTransitions.push({ taskId, state, fixRounds });
        origSetTaskState(sessionId, taskId, state, fixRounds);
      };

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev 1
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), '// dev 1\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC 1: fail
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'fail',
            bugs: ['bug 1'],
            fix: ['fix 1'],
            confirm: [],
          }),
        }),
        // Dev 2
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), '// dev 2\n');
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC 2: pass
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'pass',
            bugs: [],
            fix: [],
            confirm: [],
          }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal 1'], { approved: true });
      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');

      expect(taskStateTransitions).toEqual([
        { taskId: 'T-001', state: 'pending', fixRounds: 0 },
        { taskId: 'T-001', state: 'in_dev', fixRounds: 0 },
        { taskId: 'T-001', state: 'awaiting_qc', fixRounds: 0 },
        { taskId: 'T-001', state: 'returned', fixRounds: 1 },
        { taskId: 'T-001', state: 'in_dev', fixRounds: 1 },
        { taskId: 'T-001', state: 'awaiting_qc', fixRounds: 1 },
        { taskId: 'T-001', state: 'passed', fixRounds: 1 },
      ]);

      const finalStates = store.listTaskStates(outcome.sessionId!);
      expect(finalStates).toEqual([
        expect.objectContaining({
          task_id: 'T-001',
          state: 'passed',
          fix_rounds: 1,
        }),
      ]);

      store.close();
    });

    it('mỗi lượt có log_file = <logDir>/turn-<id>.log trước khi runner được gọi (runner giả đọc listTurns thấy đã có)', async () => {
      const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
      const { deps, store } = makeDeps(repo);

      const observedLogFilesDuringRunnerCalls: string[] = [];
      const runnerLogFileArgs: string[] = [];

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd, logFile) => {
          runnerLogFileArgs.push(logFile || '');
          const turns = store.listTurns(1);
          expect(turns.length).toBe(1);
          const currentTurn = turns[0];
          expect(currentTurn.log_file).toBe(join(deps.logDir, `turn-${currentTurn.id}.log`));
          observedLogFilesDuringRunnerCalls.push(currentTurn.log_file!);

          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev
        (_s, _a, _p, cwd, logFile) => {
          runnerLogFileArgs.push(logFile || '');
          const turns = store.listTurns(1);
          expect(turns.length).toBe(2);
          const currentTurn = turns[1];
          expect(currentTurn.log_file).toBe(join(deps.logDir, `turn-${currentTurn.id}.log`));
          observedLogFilesDuringRunnerCalls.push(currentTurn.log_file!);

          writeFileSync(join(cwd, 'src', 'app.ts'), '// dev\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC
        (_s, _a, _p, _cwd, logFile) => {
          runnerLogFileArgs.push(logFile || '');
          const turns = store.listTurns(1);
          expect(turns.length).toBe(3);
          const currentTurn = turns[2];
          expect(currentTurn.log_file).toBe(join(deps.logDir, `turn-${currentTurn.id}.log`));
          observedLogFilesDuringRunnerCalls.push(currentTurn.log_file!);

          return {
            lastMessage: JSON.stringify({
              verdict: 'pass',
              bugs: [],
              fix: [],
              confirm: [],
            }),
          };
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal 1'], { approved: true });
      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');

      // Verify that all 3 runner calls observed valid log files registered before call
      expect(observedLogFilesDuringRunnerCalls).toEqual([
        join(deps.logDir, 'turn-1.log'),
        join(deps.logDir, 'turn-2.log'),
        join(deps.logDir, 'turn-3.log'),
      ]);
      expect(runnerLogFileArgs).toEqual([
        join(deps.logDir, 'turn-1.log'),
        join(deps.logDir, 'turn-2.log'),
        join(deps.logDir, 'turn-3.log'),
      ]);

      const allTurns = store.listTurns(1);
      expect(allTurns.map((t) => t.log_file)).toEqual([
        join(deps.logDir, 'turn-1.log'),
        join(deps.logDir, 'turn-2.log'),
        join(deps.logDir, 'turn-3.log'),
      ]);

      store.close();
    });

    it('gate rớt còn vòng → returned (fix_rounds: 1); hết vòng → failed; BLOCKED → blocked', async () => {
      // 1. BLOCKED -> blocked
      const repoBlocked = tmpRepo({ 'src/app.ts': '1' });
      const { deps: depsBlocked, store: storeBlocked } = makeDeps(repoBlocked);
      const blockedTransitions: Array<{ taskId: string; state: string; fixRounds: number }> = [];
      storeBlocked.setTaskState = (sessionId, taskId, state, fixRounds) => {
        blockedTransitions.push({ taskId, state, fixRounds });
      };
      const { runner: runnerBlocked } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev: reports BLOCKED
        () => ({
          lastMessage: 'BLOCKED: dependencies missing',
        }),
      ]);
      depsBlocked.runner = runnerBlocked;
      await runSession(depsBlocked, ['Goal 1'], { approved: true });
      expect(blockedTransitions).toContainEqual({ taskId: 'T-001', state: 'blocked', fixRounds: 0 });
      storeBlocked.close();

      // 2. gate fails -> returned with fixRounds: 1
      const repoGate = tmpRepo({ 'src/app.ts': '1' });
      const { deps: depsGate, store: storeGate } = makeDeps(repoGate);
      const gateTransitions: Array<{ taskId: string; state: string; fixRounds: number }> = [];
      storeGate.setTaskState = (sessionId, taskId, state, fixRounds) => {
        gateTransitions.push({ taskId, state, fixRounds });
      };
      const { runner: runnerGate } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev 1: out of scope
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'out.txt'), 'bad');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // Dev 2: fixed
        (_s, _a, _p, cwd) => {
          git(cwd, 'rm', 'out.txt');
          writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed');
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);
      depsGate.runner = runnerGate;
      await runSession(depsGate, ['Goal 1'], { approved: true });
      expect(gateTransitions).toContainEqual({ taskId: 'T-001', state: 'returned', fixRounds: 1 });
      storeGate.close();

      // 3. gate exceeds max_fix_rounds -> failed
      const repoExceed = tmpRepo({ 'src/app.ts': '1' });
      const { deps: depsExceed, store: storeExceed } = makeDeps(repoExceed, {
        turn: {
          ...loadConfig('btm.config.yaml').turn,
          max_fix_rounds: 0,
        },
      });
      const exceedTransitions: Array<{ taskId: string; state: string; fixRounds: number }> = [];
      storeExceed.setTaskState = (sessionId, taskId, state, fixRounds) => {
        exceedTransitions.push({ taskId, state, fixRounds });
      };
      const { runner: runnerExceed } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev: out of scope -> gate fails immediately exceeding max_fix_rounds (0)
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'out.txt'), 'bad');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
      ]);
      depsExceed.runner = runnerExceed;
      await runSession(depsExceed, ['Goal 1'], { approved: true });
      expect(exceedTransitions).toContainEqual({ taskId: 'T-001', state: 'failed', fixRounds: 1 });
      storeExceed.close();
    });

    it('P2-T8 A: thẻ T-001 cũ có sẵn + PM tạo T-002 → chỉ T-002 được làm', async () => {
      // Create repo with existing T-001.md on main
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
        'team/tasks/T-001.md': `---
id: T-001
goal: Old task
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`,
      });

      const { deps, store } = makeDeps(repo);
      const devTasks: string[] = [];

      const { runner } = createFakeRunner([
        // PM creates T-002
        (_s, _a, _p, cwd) => {
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-002.md'),
            `---
id: T-002
goal: New task 2
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev for T-002
        (_s, _a, prompt, cwd) => {
          devTasks.push(prompt);
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-002-dev.md'), 'OK');
        },
        // QC for T-002
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);

      deps.runner = runner;
      const outcome = await runSession(deps, ['Goal 2'], { approved: true });

      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      // Only T-002 should be in outcome.tasks
      expect(Object.keys(outcome.tasks)).toEqual(['T-002']);
      expect(outcome.tasks['T-002']).toBe('passed');
      expect(outcome.tasks['T-001']).toBeUndefined();

      // Dev prompt was only called once, for T-002
      expect(devTasks).toHaveLength(1);
      expect(devTasks[0]).toContain('T-002');
      expect(devTasks[0]).not.toContain('T-001');

      // Verify session_tasks in DB
      expect(store.getSessionTasks(outcome.sessionId!)).toEqual(['T-002']);
      store.close();
    });

    it('P2-T8 A: resumeSession dùng đúng tập thẻ của commit PM của phiên đó (session_tasks)', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
        'team/tasks/T-001.md': `---
id: T-001
goal: Old task
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`,
      });

      const { deps, store } = makeDeps(repo, {
        session: {
          ...loadConfig('btm.config.yaml').session,
          require_task_approval: true,
        },
      });

      const { runner: runnerPm } = createFakeRunner([
        // PM creates T-002
        (_s, _a, _p, cwd) => {
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-002.md'),
            `---
id: T-002
goal: New task 2
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
      ]);

      deps.runner = runnerPm;
      const initialOutcome = await runSession(deps, ['Goal 2'], { approved: false });
      expect(initialOutcome.status).toBe('awaiting_approval');
      expect(Object.keys(initialOutcome.tasks)).toEqual(['T-002']);
      expect(store.getSessionTasks(initialOutcome.sessionId!)).toEqual(['T-002']);

      // Now resume the session
      const devTasks: string[] = [];
      const { runner: runnerResume } = createFakeRunner([
        // Dev for T-002
        (_s, _a, prompt, cwd) => {
          devTasks.push(prompt);
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-002-dev.md'), 'OK');
        },
        // QC for T-002
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);

      deps.runner = runnerResume;
      const resumeOutcome = await resumeSession(deps, initialOutcome.sessionId!);
      expect(resumeOutcome.status).toBe('done');
      expect(Object.keys(resumeOutcome.tasks)).toEqual(['T-002']);
      expect(resumeOutcome.tasks['T-002']).toBe('passed');
      expect(devTasks).toHaveLength(1);
      expect(devTasks[0]).toContain('T-002');
      store.close();
    });

    it('P2-T8 A: khi PM bị abort hoặc timeout: commitAll WIP trên nhánh phiên để working tree sạch', async () => {
      // Subtest 1: Abort
      const repoAbort = tmpRepo({ 'src/app.ts': '1' });
      const { deps: depsAbort, store: storeAbort } = makeDeps(repoAbort);
      const abortCtrl = new AbortController();
      depsAbort.signal = abortCtrl.signal;

      depsAbort.runner = async (_seat, _agent, _prompt, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'tasks', 'draft.md'), 'draft card');
        abortCtrl.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      };

      const outcomeAbort = await runSession(depsAbort, ['Goal 1'], { approved: true });
      expect(outcomeAbort.status).toBe('stopped');
      // Working tree must be clean
      expect(git(repoAbort, 'status', '--porcelain').trim()).toBe('');
      // Last commit on session branch is WIP
      const lastCommitAbort = git(repoAbort, 'log', '-1', '--pretty=%B').trim();
      expect(lastCommitAbort).toMatch(/^WIP pm: aborted/);
      storeAbort.close();

      // Subtest 2: Timeout
      const repoTimeout = tmpRepo({ 'src/app.ts': '1' });
      const { deps: depsTimeout, store: storeTimeout } = makeDeps(repoTimeout);
      depsTimeout.runner = async (_seat, _agent, _prompt, cwd) => {
        mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'tasks', 'draft.md'), 'draft timeout');
        return {
          exitCode: null,
          timedOut: true,
          durationMs: 1000,
          output: '',
          lastMessage: '',
        };
      };

      const outcomeTimeout = await runSession(depsTimeout, ['Goal 1'], { approved: true });
      expect(outcomeTimeout.status).toBe('needs_owner');
      // Working tree must be clean
      expect(git(repoTimeout, 'status', '--porcelain').trim()).toBe('');
      const lastCommitTimeout = git(repoTimeout, 'log', '-1', '--pretty=%B').trim();
      expect(lastCommitTimeout).toMatch(/^WIP pm: timeout/);
      storeTimeout.close();
    });

    it('P2-T8 A: đầu phiên working tree bẩn → commitAll "checkpoint before session <id>" trước khi checkout nhánh mới', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'initial' });
      // Make working tree dirty on main before runSession
      writeFileSync(join(repo, 'src', 'app.ts'), 'dirty before session');
      writeFileSync(join(repo, 'dirty-untracked.txt'), 'hello');

      const { deps, store } = makeDeps(repo);
      const { runner } = createFakeRunner([
        // PM creates T-001
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed in session');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);

      deps.runner = runner;
      const outcome = await runSession(deps, ['Goal 1'], { approved: true });
      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');

      // Check commit log on base branch (main) for checkpoint commit
      const baseBranch = deps.cfg.git.protected_branch || 'main';
      const mainLog = git(repo, 'log', baseBranch, '-n', '2', '--pretty=%s');
      expect(mainLog).toContain(`checkpoint before session ${outcome.sessionId}`);
      store.close();
    });

    it('P2-T8: config require_task_approval=false nhưng approved=false → awaiting_approval', async () => {
      const repo = tmpRepo({});
      const { deps, store } = makeDeps(repo, {
        session: {
          ...loadConfig('btm.config.yaml').session,
          require_task_approval: false,
        },
      });

      const { runner, calls } = createFakeRunner([
        (_seat, _agent, _prompt, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Goal 1
scope:
  - file.txt
acceptance:
  - ok
done_when: done
---
`
          );
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal 1'], { approved: false });

      expect(outcome.status).toBe('awaiting_approval');
      expect(outcome.sessionId).toBe(1);
      expect(calls.length).toBe(1);
      expect(calls[0].seat).toBe('pm');
      expect(store.countTurns(1)).toBe(1);

      store.close();
    });

    it('P2-T8: chỉ parse thẻ trong diff PM; thẻ cũ hỏng + PM tạo T-002 hợp lệ → chạy được cả runSession và resumeSession', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
        'team/tasks/T-001.md': 'corrupted yaml content ::: invalid\n',
      });

      const { deps, store } = makeDeps(repo);
      let devCalledFor = '';

      const { runner } = createFakeRunner([
        // PM creates valid T-002
        (_s, _a, _p, cwd) => {
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-002.md'),
            `---
id: T-002
goal: Feature 2
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`
          );
        },
        // Dev
        (_s, _a, prompt, cwd) => {
          devCalledFor = prompt;
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-002-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);

      deps.runner = runner;
      const outcome = await runSession(deps, ['Goal 2'], { approved: true });

      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      expect(outcome.tasks['T-002']).toBe('passed');
      expect(outcome.tasks['T-001']).toBeUndefined();
      expect(devCalledFor).toContain('T-002');
      expect(devCalledFor).not.toContain('T-001');

      // Test resumeSession when T-001 is broken and session_tasks has ['T-002']
      const sId = store.createSession(['Resume test'], repo);
      store.setSessionTasks(sId, ['T-002']);
      store.setSessionStatus(sId, 'awaiting_approval');

      git(repo, 'checkout', '-b', `session/${sId}`);

      const { runner: runnerResume } = createFakeRunner([
        // Dev
        (_s, _a, prompt, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 3;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-002-dev.md'), 'OK');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);
      deps.runner = runnerResume;

      const resumeOutcome = await resumeSession(deps, sId);
      expect(resumeOutcome.status).toBe('done');
      expect(resumeOutcome.tasks['T-002']).toBe('passed');
      expect(resumeOutcome.tasks['T-001']).toBeUndefined();

      store.close();
    });

    it('P2-T8: resume với session_tasks rỗng → needs_owner "no_session_tasks", không lấy thẻ khác', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
        'team/tasks/T-001.md': `---
id: T-001
goal: Existing task
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
---
`,
      });

      const { deps, store } = makeDeps(repo);
      const sId = store.createSession(['Goal empty'], repo);
      expect(store.getSessionTasks(sId)).toEqual([]);
      store.setSessionStatus(sId, 'awaiting_approval');
      git(repo, 'checkout', '-b', `session/${sId}`);

      let devOrQcCalled = false;
      deps.runner = async () => {
        devOrQcCalled = true;
        return { exitCode: 0, timedOut: false, durationMs: 0, output: '', lastMessage: '' };
      };

      const outcome = await resumeSession(deps, sId);

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('no_session_tasks');
      expect(devOrQcCalled).toBe(false);
      expect(outcome.tasks['T-001']).toBeUndefined();

      store.close();
    });

    it('Task 10a: phiên done + thẻ passed → note done; khác → needs_owner, note open', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      mkdirSync(join(repo, 'team', 'inbox'), { recursive: true });
      writeFileSync(
        join(repo, 'team', 'inbox', 'N-1.md'),
        `---
id: N-1
from: owner
status: open
at: 2026-11-08T08:00:00.000Z
image: N-1.png
---
Yêu cầu cập nhật nút
`
      );
      writeFileSync(join(repo, 'team', 'inbox', 'N-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      commitAll(repo, 'inbox N-1', { name: 'owner', email: 'owner@btm.local' });

      const { deps, store } = makeDeps(repo);
      const noteId = store.createNote(repo, 'Yêu cầu cập nhật nút', 'N-1.png');

      const { runner } = createFakeRunner([
        // PM creates card with note: N-1
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Cập nhật nút
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
note: N-1
---
`
          );
        },
        // Dev
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC passes
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(
        deps,
        ['Xử lý ghi chú team N-1: Yêu cầu cập nhật nút'],
        { approved: true, noteId }
      );

      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      expect(outcome.tasks['T-001']).toBe('passed');

      // Note in DB must be done
      const noteAfter = store.getNote(noteId);
      expect(noteAfter?.status).toBe('done');

      // Note in file must be done
      const fileContent = readFileSync(join(repo, 'team', 'inbox', 'N-1.md'), 'utf8');
      expect(fileContent).toContain('status: done');

      store.close();
    });

    it('lỗi ghi/commit khi đóng note → note giữ open trong DB, phiên needs_owner với lý do, không nuốt lỗi', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      mkdirSync(join(repo, 'team', 'inbox'), { recursive: true });
      const notePath = join(repo, 'team', 'inbox', 'N-1.md');
      writeFileSync(
        notePath,
        `---
id: N-1
from: owner
status: open
at: 2026-11-08T08:00:00.000Z
---
Yêu cầu cập nhật nút
`
      );
      commitAll(repo, 'inbox N-1', { name: 'owner', email: 'owner@btm.local' });

      const { deps, store } = makeDeps(repo);
      const noteId = store.createNote(repo, 'Yêu cầu cập nhật nút');

      const { runner } = createFakeRunner([
        // PM creates card with note: N-1
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Cập nhật nút
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
note: N-1
---
`
          );
        },
        // Dev
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC passes, but right before closing note we make notePath read-only
        () => {
          chmodSync(notePath, 0o444);
          return {
            lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
          };
        },
      ]);
      deps.runner = runner;

      try {
        const outcome = await runSession(
          deps,
          ['Xử lý ghi chú team N-1: Yêu cầu cập nhật nút'],
          { approved: true, noteId }
        );

        // Outcome must be needs_owner because closing note failed!
        expect(outcome.status).toBe('needs_owner');
        expect(outcome.notes.some((n) => n.includes('close') || n.includes('EACCES'))).toBe(true);

        // Note in DB must remain open
        const noteAfter = store.getNote(noteId);
        expect(noteAfter?.status).toBe('open');
      } finally {
        chmodSync(notePath, 0o644);
        store.close();
      }
    });

    it('Task 10a: commit đóng note lỗi → khôi phục file về status: open (git checkout file) rồi needs_owner', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      mkdirSync(join(repo, 'team', 'inbox'), { recursive: true });
      const notePath = join(repo, 'team', 'inbox', 'N-1.md');
      writeFileSync(
        notePath,
        `---
id: N-1
from: owner
status: open
at: 2026-11-08T08:00:00.000Z
---
Yêu cầu đóng note nhưng commit lỗi
`
      );
      commitAll(repo, 'inbox N-1', { name: 'owner', email: 'owner@btm.local' });

      const { deps, store } = makeDeps(repo);
      const noteId = store.createNote(repo, 'Yêu cầu đóng note nhưng commit lỗi');

      const origCommitAll = gitModule.commitAll;
      const commitSpy = vi.spyOn(gitModule, 'commitAll').mockImplementation((repoArg, msg, author) => {
        if (msg.startsWith('close note')) {
          // Giả lập commit lỗi SAU khi đã stage (git add -A)
          git(repoArg, 'add', '-A');
          throw new Error('Simulated git commit error on close note after stage');
        }
        return origCommitAll(repoArg, msg, author);
      });

      const { runner } = createFakeRunner([
        // PM creates card with note: N-1
        (_s, _a, _p, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---
id: T-001
goal: Test commit failure
scope:
  - src/app.ts
acceptance:
  - ok
done_when: done
note: N-1
---
Do task
`
          );
        },
        // Dev
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
        },
        // QC -> passed
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);

      deps.runner = runner;

      try {
        const outcome = await runSession(deps, ['Mục tiêu test commit close note fail'], {
          approved: true,
          noteId,
        });

        expect(outcome.status).toBe('needs_owner');
        expect(outcome.notes.some((n) => n.includes('close note N-1 error'))).toBe(true);

        // Verify file is restored to status: open via git checkout
        const fileContent = readFileSync(notePath, 'utf8');
        expect(fileContent).toContain('status: open');
        expect(fileContent).not.toContain('status: done');

        // Verify git index is reset for note file
        const diffCached = git(repo, 'diff', '--cached', '--name-only');
        expect(diffCached).not.toContain('team/inbox/N-1.md');

        // Verify DB note status is not done
        const noteRow = store.getNote(noteId);
        expect(noteRow?.status).toBe('open');
      } finally {
        commitSpy.mockRestore();
        store.close();
      }
    });

    it('passes card note image absolute path to QC runner options', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      const { deps, store } = makeDeps(repo);

      // Create note with image
      const noteId = store.createNote(repo, 'Fix UI bug with image', 'N-1.png');
      const inboxDir = join(repo, 'team', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, 'N-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(
        join(inboxDir, 'N-1.md'),
        `---\nid: N-1\nfrom: owner\nstatus: open\nat: 2026-11-08T08:00:00.000Z\nimage: N-1.png\n---\nFix UI bug with image\n`
      );
      commitAll(repo, 'inbox N-1', { name: 'owner', email: 'owner@btm.local' });

      // Card content
      const cardContent = `---
id: T-001
goal: Update button color
scope:
  - src/app.ts
acceptance:
  - Button color updated
done_when: tests pass
note: N-${noteId}
---
Details here.
`;

      let capturedQcOptions: any;

      deps.runner = async (seat, agentId, prompt, cwd, logFile, options) => {
        if (seat === 'pm') {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'tasks', 'T-001.md'), cardContent, 'utf8');
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        if (seat === 'dev') {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        if (seat === 'qc') {
          capturedQcOptions = options;
          return {
            exitCode: 0,
            timedOut: false,
            durationMs: 10,
            output: '',
            lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
          };
        }
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: '' };
      };

      const outcome = await runSession(deps, ['Work on T-001'], { approved: true, noteId });
      expect(outcome.notes).toEqual([]);
      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      expect(capturedQcOptions?.images).toBeDefined();
      expect(capturedQcOptions.images).toEqual([resolve(repo, 'team', 'inbox', 'N-1.png')]);

      store.close();
    });

    it('noteId chỉ truyền tường minh qua opts (không suy từ chuỗi goal) và chỉ gắn note cùng project', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      const otherRepo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      const { deps, store } = makeDeps(repo);

      // Note 1: belongs to current repo
      const note1 = store.createNote(repo, 'Note for current repo');
      const inboxDir = join(repo, 'team', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, `N-${note1}.md`),
        `---\nid: N-${note1}\nfrom: owner\nstatus: open\nat: 2026-11-08T08:00:00.000Z\n---\nNote for current repo\n`
      );
      commitAll(repo, 'inbox note 1', { name: 'owner', email: 'owner@btm.local' });

      // Note 2: belongs to other repo
      const note2 = store.createNote(otherRepo, 'Note for other repo');

      const cardContent = (nId?: number) => `---
id: T-001
goal: Update button color
scope:
  - src/app.ts
acceptance:
  - Button color updated
done_when: tests pass
${nId ? `note: N-${nId}\n` : ''}---
`;

      let currentNoteForPm: number | undefined;

      deps.runner = async (seat, _agentId, _prompt, cwd) => {
        if (seat === 'pm') {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'tasks', 'T-001.md'), cardContent(currentNoteForPm), 'utf8');
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        if (seat === 'dev') {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        if (seat === 'qc') {
          return {
            exitCode: 0,
            timedOut: false,
            durationMs: 10,
            output: '',
            lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
          };
        }
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: '' };
      };

      // 1. Goal contains N-1, but opts does not pass noteId -> MUST NOT attach note 1!
      currentNoteForPm = undefined;
      const outcome1 = await runSession(deps, [`Xử lý ghi chú team N-${note1}: Lỗi`], { approved: true });
      expect(outcome1.status).toBe('done');
      const session1Notes = store.getNotesBySession(outcome1.sessionId!);
      expect(session1Notes.length).toBe(0);

      // 2. Opts passes note2 from another repo -> MUST NOT attach note 2!
      currentNoteForPm = undefined;
      const outcome2 = await runSession(deps, ['Fix task with note2'], { approved: true, noteId: note2 });
      expect(outcome2.status).toBe('done');
      const session2Notes = store.getNotesBySession(outcome2.sessionId!);
      expect(session2Notes.length).toBe(0);

      // 3. Opts passes note1 from same repo -> MUST attach note 1!
      currentNoteForPm = note1;
      const outcome3 = await runSession(deps, ['Fix task with note1'], { approved: true, noteId: note1 });
      expect(outcome3.status).toBe('done');
      const session3Notes = store.getNotesBySession(outcome3.sessionId!);
      expect(session3Notes.length).toBe(1);
      expect(session3Notes[0].id).toBe(note1);

      store.close();
    });

    it('P2-T10c: repo đang ở nhánh session cũ có commit lạ; gửi note → nhánh phiên mới chứa team/inbox/N-x.md và ảnh, nhánh cũ không bị đổi; runner giả của lượt PM thấy file tồn tại', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      const { deps, store } = makeDeps(repo);

      // Create an old session branch with an extra commit
      git(repo, 'checkout', '-b', 'session/old-8');
      writeFileSync(join(repo, 'strange.txt'), 'commit lạ trên nhánh cũ\n');
      commitAll(repo, 'strange commit on old session', { name: 'dev', email: 'dev@btm.local' });
      const oldSha = headSha(repo);

      // Verify we are on session/old-8
      const currentBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      expect(currentBranch).toBe('session/old-8');

      // Create note in DB
      const noteId = store.createNote(repo, 'Lỗi hiển thị banner cần sửa', null);
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

      let pmSawNoteMd = false;
      let pmSawImage = false;
      let pmSawCorrectBranch = false;
      let pmSawNoteContent = '';

      const cardContent = `---
id: T-001
goal: Sửa lỗi banner
scope:
  - src/app.ts
acceptance:
  - Banner hiển thị đúng
done_when: tests pass
note: N-${noteId}
---
`;

      deps.runner = async (seat, _agentId, _prompt, cwd) => {
        if (seat === 'pm') {
          const pmBranch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
          pmSawCorrectBranch = pmBranch === 'session/1';

          const mdFile = join(cwd, 'team', 'inbox', `N-${noteId}.md`);
          const imgFile = join(cwd, 'team', 'inbox', `N-${noteId}.png`);
          pmSawNoteMd = existsSync(mdFile);
          pmSawImage = existsSync(imgFile);
          if (pmSawNoteMd) {
            pmSawNoteContent = readFileSync(mdFile, 'utf8');
          }

          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'tasks', 'T-001.md'), cardContent, 'utf8');
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        if (seat === 'dev') {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK');
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        if (seat === 'qc') {
          return {
            exitCode: 0,
            timedOut: false,
            durationMs: 10,
            output: '',
            lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
          };
        }
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: '' };
      };

      const outcome = await runSession(
        deps,
        [`Xử lý ghi chú team N-${noteId}: Lỗi hiển thị banner cần sửa`],
        {
          approved: true,
          noteId,
          text: 'Lỗi hiển thị banner cần sửa',
          image: { ext: 'png', bytes: pngBuf },
        }
      );

      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      expect(pmSawCorrectBranch).toBe(true);
      expect(pmSawNoteMd).toBe(true);
      expect(pmSawImage).toBe(true);
      expect(pmSawNoteContent).toContain(`id: N-${noteId}`);
      expect(pmSawNoteContent).toContain(`image: N-${noteId}.png`);
      expect(pmSawNoteContent).toContain('Lỗi hiển thị banner cần sửa');

      // Check new session branch contains inbox files and commit
      git(repo, 'checkout', 'session/1');
      expect(existsSync(join(repo, 'team', 'inbox', `N-${noteId}.md`))).toBe(true);
      expect(existsSync(join(repo, 'team', 'inbox', `N-${noteId}.png`))).toBe(true);
      const newLog = git(repo, 'log', '-n', '5', '--pretty=format:%s %an');
      expect(newLog).toContain(`inbox N-${noteId} owner`);

      // Check old session branch is completely unchanged
      git(repo, 'checkout', 'session/old-8');
      expect(headSha(repo)).toBe(oldSha);
      expect(existsSync(join(repo, 'team', 'inbox', `N-${noteId}.md`))).toBe(false);
      expect(existsSync(join(repo, 'team', 'inbox', `N-${noteId}.png`))).toBe(false);
      const oldLog = git(repo, 'log', '-n', '1', '--pretty=format:%s');
      expect(oldLog).toBe('strange commit on old session');

      store.close();
    });

    it('P2-T10c: lỗi ghi note/ảnh trong runSession → xóa file vừa ghi, xóa bản ghi note, phiên needs_owner', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      const { deps, store } = makeDeps(repo);

      // Pre-create N-1.md on main branch so that write in session/<id> fails with collision
      const inboxDir = join(repo, 'team', 'inbox');
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, 'N-1.md'), 'existing note file on main');
      commitAll(repo, 'pre-existing N-1.md', { name: 'owner', email: 'owner@btm.local' });

      const noteId = store.createNote(repo, 'Lỗi va chạm file', null);
      expect(noteId).toBe(1);

      let pmCalled = false;
      deps.runner = async (seat) => {
        if (seat === 'pm') {
          pmCalled = true;
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: '' };
      };

      const outcome = await runSession(
        deps,
        [`Xử lý ghi chú team N-${noteId}: Lỗi va chạm file`],
        {
          approved: true,
          noteId,
          text: 'Lỗi va chạm file',
        }
      );

      expect(outcome.status).toBe('needs_owner');
      expect(pmCalled).toBe(false);

      // Verify DB note record is deleted
      expect(store.getNote(noteId)).toBeNull();

      store.close();
    });

    it('P2-T10c: lỗi commitAll inbox note trong runSession → xóa file vừa ghi, xóa bản ghi note, phiên needs_owner', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const x = 1;\n',
      });
      const { deps, store } = makeDeps(repo);

      const noteId = store.createNote(repo, 'Test commit error', null);
      const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

      const origCommitAll = gitModule.commitAll;
      const commitSpy = vi.spyOn(gitModule, 'commitAll').mockImplementation((repoArg, msg, author) => {
        if (msg.startsWith('inbox N-')) {
          throw new Error('Simulated git commit error on inbox note');
        }
        return origCommitAll(repoArg, msg, author);
      });

      let pmCalled = false;
      deps.runner = async (seat) => {
        if (seat === 'pm') {
          pmCalled = true;
          return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
        }
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: '' };
      };

      try {
        const outcome = await runSession(
          deps,
          [`Xử lý ghi chú team N-${noteId}: Test commit error`],
          {
            approved: true,
            noteId,
            text: 'Test commit error',
            image: { ext: 'png', bytes: pngBuf },
          }
        );

        expect(outcome.status).toBe('needs_owner');
        expect(pmCalled).toBe(false);

        // Verify written files are deleted
        const mdPath = join(repo, 'team', 'inbox', `N-${noteId}.md`);
        const imgPath = join(repo, 'team', 'inbox', `N-${noteId}.png`);
        expect(existsSync(mdPath)).toBe(false);
        expect(existsSync(imgPath)).toBe(false);

        // Verify DB note record is deleted
        expect(store.getNote(noteId)).toBeNull();
      } finally {
        commitSpy.mockRestore();
        store.close();
      }
    });
  });

  describe('Energy Gate & Login Gate in Session (Task 3)', () => {
    let repo: string;
    let cfg: Config;
    let store: Store;
    let logDir: string;

    beforeEach(() => {
      repo = tmpRepo({
        'src/app.ts': 'export const app = 1;\n',
      });
      cfg = loadConfig('btm.config.yaml');
      cfg.host.projects_root = dirname(repo);
      cfg.turn.commit_before_dev_turn = false;
      cfg.gate.commands = { build: '', lint: '', test: '' };
      logDir = join(repo, '.logs');
      mkdirSync(logDir, { recursive: true });
      store = openStore(':memory:');
      store.setActiveProject(repo);
    });

    afterEach(() => {
      store.close();
    });

    it('energy 15% với ngưỡng 20 → lượt Dev không chạy, needs_owner, note có "hồi lúc"', async () => {
      let devCalled = false;
      const { runner } = createFakeRunner([
        // PM turn: tạo task card T-001
        (seat, agent, prompt, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---\nid: T-001\ngoal: Implement feature\nscope:\n  - src/\nacceptance:\n  - Works\ndone_when: Done\n---\n`
          );
        },
        // Dev turn (không được gọi tới vì bị chặn bởi gate)
        () => {
          devCalled = true;
          return { exitCode: 0, output: 'dev should not run' };
        },
      ]);

      const gate = vi.fn((agent: string) => {
        if (agent === 'jacky') {
          return { ok: false as const, reason: 'energy:5h còn 15%, hồi lúc 19:57' };
        }
        return { ok: true as const };
      });

      const deps: SessionDeps = {
        cfg,
        store,
        runner,
        repo,
        env: {},
        logDir,
        gate,
      };

      const outcome = await runSession(deps, ['Build feature'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(devCalled).toBe(false);
      expect(outcome.notes.some((n) => n.includes('hồi lúc'))).toBe(true);
      expect(outcome.notes).toContain('energy:5h còn 15%, hồi lúc 19:57');

      // Kiểm tra handoff failure được ghi trong DB
      const failures = store.listHandoffFailures(outcome.sessionId!);
      expect(failures).toHaveLength(1);
      expect(failures[0].task_id).toBe('T-001');
      expect(failures[0].reason).toBe('energy:5h còn 15%, hồi lúc 19:57');
    });

    it('energy unknown → chạy bình thường', async () => {
      let devCalled = false;
      let qcCalled = false;
      const { runner } = createFakeRunner([
        // PM turn
        (seat, agent, prompt, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---\nid: T-001\ngoal: Implement feature\nscope:\n  - src/\nacceptance:\n  - Works\ndone_when: Done\n---\n`
          );
        },
        // Dev turn
        (seat, agent, prompt, cwd) => {
          devCalled = true;
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK\n');
        },
        // QC turn
        () => {
          qcCalled = true;
          return {
            lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
          };
        },
      ]);

      const gate = vi.fn(() => ({ ok: true as const }));

      const deps: SessionDeps = {
        cfg,
        store,
        runner,
        repo,
        env: {},
        logDir,
        gate,
      };

      const outcome = await runSession(deps, ['Build feature'], { approved: true });

      expect(devCalled).toBe(true);
      expect(qcCalled).toBe(true);
      expect(outcome.status).toBe('done');
    });

    it('login relogin cho QC → Dev vẫn chạy, tới QC thì dừng', async () => {
      let devCalled = false;
      let qcCalled = false;
      const { runner } = createFakeRunner([
        // PM turn
        (seat, agent, prompt, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---\nid: T-001\ngoal: Implement feature\nscope:\n  - src/\nacceptance:\n  - Works\ndone_when: Done\n---\n`
          );
        },
        // Dev turn (chạy bình thường)
        (seat, agent, prompt, cwd) => {
          devCalled = true;
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK\n');
        },
        // QC turn (không được gọi)
        () => {
          qcCalled = true;
          return { lastMessage: '## QC PASS' };
        },
      ]);

      const gate = vi.fn((agent: string) => {
        if (agent === 'jenny') {
          return { ok: false as const, reason: 'login:relogin' };
        }
        return { ok: true as const };
      });

      const deps: SessionDeps = {
        cfg,
        store,
        runner,
        repo,
        env: {},
        logDir,
        gate,
      };

      const outcome = await runSession(deps, ['Build feature'], { approved: true });

      expect(devCalled).toBe(true);
      expect(qcCalled).toBe(false);
      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('login:relogin');

      // Kiểm tra handoff failure được ghi trong DB cho QC
      const failures = store.listHandoffFailures(outcome.sessionId!);
      expect(failures).toHaveLength(1);
      expect(failures[0].task_id).toBe('T-001');
      expect(failures[0].reason).toBe('login:relogin');
    });

    it('gọi refresh(mọi agent đang ngồi ghế) khi mở phiên và refresh([agent]) trước mỗi lượt', async () => {
      const { runner } = createFakeRunner([
        // PM
        (seat, agent, prompt, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---\nid: T-001\ngoal: Implement feature\nscope:\n  - src/\nacceptance:\n  - Works\ndone_when: Done\n---\n`
          );
        },
        // Dev
        (seat, agent, prompt, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK\n');
        },
        // QC
        () => ({ lastMessage: '## QC PASS\n' }),
      ]);

      const refreshCalls: string[][] = [];
      const refresh = vi.fn(async (agents: string[]) => {
        refreshCalls.push(agents);
      });

      const deps: SessionDeps = {
        cfg,
        store,
        runner,
        repo,
        env: {},
        logDir,
        refresh,
        gate: () => ({ ok: true as const }),
      };

      await runSession(deps, ['Build feature'], { approved: true });

      // Lần 1: mở phiên -> refresh mọi agent ngồi ghế (elon, jacky, jenny)
      expect(refreshCalls[0]).toEqual(expect.arrayContaining(['elon', 'jacky', 'jenny']));
      // Các lần tiếp theo: before_turn cho pm, dev, qc
      expect(refreshCalls).toContainEqual(['elon']);
      expect(refreshCalls).toContainEqual(['jacky']);
      expect(refreshCalls).toContainEqual(['jenny']);
    });

    it('refresh reject khi mở phiên -> coi như unknown, phiên tiếp tục bình thường và setSessionStatus được gọi', async () => {
      const { runner } = createFakeRunner([
        // PM
        (seat, agent, prompt, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---\nid: T-001\ngoal: Implement feature\nscope:\n  - src/app.ts\nacceptance:\n  - Works\ndone_when: Done\n---\n`
          );
        },
        // Dev
        (seat, agent, prompt, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK\n');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);

      const refresh = vi.fn().mockRejectedValue(new Error('Network offline reading quota'));

      const deps: SessionDeps = {
        cfg,
        store,
        runner,
        repo,
        env: {},
        logDir,
        refresh,
        gate: () => ({ ok: true as const }),
      };

      const outcome = await runSession(deps, ['Build feature'], { approved: true });

      expect(outcome.status).toBe('done');
      const session = store.getSession(outcome.sessionId!);
      expect(session?.status).toBe('done');
    });

    it('refresh reject khi resume phiên -> coi như unknown, phiên tiếp tục và luôn setSessionStatus trong finally', async () => {
      const sId = store.createSession(['Build feature'], repo);
      store.setSessionStatus(sId, 'awaiting_approval');
      store.setSessionTasks(sId, ['T-001']);
      store.setTaskState(sId, 'T-001', 'pending', 0);

      git(repo, 'checkout', '-b', `session/${sId}`);

      mkdirSync(join(repo, 'team', 'tasks'), { recursive: true });
      writeFileSync(
        join(repo, 'team', 'tasks', 'T-001.md'),
        `---\nid: T-001\ngoal: Implement feature\nscope:\n  - src/app.ts\nacceptance:\n  - Works\ndone_when: Done\n---\n`
      );
      commitAll(repo, 'pm: task cards', { name: 'elon', email: 'elon@btm.local' });

      const { runner } = createFakeRunner([
        // Dev
        (seat, agent, prompt, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK\n');
        },
        // QC
        () => ({
          lastMessage: JSON.stringify({ verdict: 'pass', bugs: [], fix: [], confirm: [] }),
        }),
      ]);

      const refresh = vi.fn().mockRejectedValue(new Error('Quota CLI network timeout'));

      const deps: SessionDeps = {
        cfg,
        store,
        runner,
        repo,
        env: {},
        logDir,
        refresh,
        gate: () => ({ ok: true as const }),
      };

      const outcome = await resumeSession(deps, sId);

      expect(outcome.notes).toEqual([]);
      expect(outcome.status).toBe('done');
      const session = store.getSession(sId);
      expect(session?.status).toBe('done');
    });

    it('test tích hợp session + monitor thật: Energy 50% ở lượt Dev, tụt 10% trước lượt QC -> QC không chạy, needs_owner có "hồi lúc"', async () => {
      let devRan = false;
      let qcRan = false;
      let jennyEnergy = 50; // Ban đầu 50% ở lượt Dev

      let nowTime = new Date('2026-11-08T15:00:00.000Z');
      const now = () => nowTime;

      const { runner } = createFakeRunner([
        // PM
        (seat, agent, prompt, cwd) => {
          mkdirSync(join(cwd, 'team', 'tasks'), { recursive: true });
          writeFileSync(
            join(cwd, 'team', 'tasks', 'T-001.md'),
            `---\nid: T-001\ngoal: Implement feature\nscope:\n  - src/\nacceptance:\n  - Works\ndone_when: Done\n---\n`
          );
        },
        // Dev
        (seat, agent, prompt, cwd) => {
          devRan = true;
          // Dev chạy tốn thời gian (200s > cache_seconds 180s) và trước QC thì energy tụt còn 10%
          nowTime = new Date(nowTime.getTime() + 200_000);
          jennyEnergy = 10;
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 100;\n');
          mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
          writeFileSync(join(cwd, 'team', 'reports', 'T-001-dev.md'), 'OK\n');
        },
        // QC
        () => {
          qcRan = true;
          return { lastMessage: '## QC PASS\n' };
        },
      ]);

      const mockReadEnergy = vi.fn(async (agent: string) => {
        if (agent === 'jacky') {
          return {
            agent: 'jacky',
            status: 'fresh' as const,
            windows: [{ name: '5h', remainingPercent: 50, resetsAt: '2026-11-08T18:00:00Z' }],
            readAt: nowTime.toISOString(),
          };
        }
        if (agent === 'jenny') {
          return {
            agent: 'jenny',
            status: 'fresh' as const,
            windows: [{ name: '5h', remainingPercent: jennyEnergy, resetsAt: '2026-11-08T19:57:00Z' }],
            readAt: nowTime.toISOString(),
          };
        }
        return {
          agent,
          status: 'fresh' as const,
          windows: [{ name: '5h', remainingPercent: 80, resetsAt: '2026-11-08T20:00:00Z' }],
          readAt: nowTime.toISOString(),
        };
      });

      const mockCheckLogin = vi.fn(async (agent: string) => ({
        agent,
        state: 'ok' as const,
        detail: 'Ổn',
      }));

      const monitor = createMonitor({
        cfg,
        store,
        readEnergy: mockReadEnergy as any,
        checkLogin: mockCheckLogin as any,
        now,
      });

      const deps: SessionDeps = {
        cfg,
        store,
        runner,
        repo,
        env: {},
        logDir,
        monitor,
      };

      const outcome = await runSession(deps, ['Implement feature'], { approved: true });

      expect(devRan).toBe(true);
      expect(qcRan).toBe(false);
      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes.some((note) => note.includes('hồi lúc'))).toBe(true);
      expect(outcome.notes.some((note) => note.includes('10%') && note.includes('19:57'))).toBe(true);

      const failures = store.listHandoffFailures(outcome.sessionId!);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0].reason).toContain('hồi lúc');
    });
  });
});
