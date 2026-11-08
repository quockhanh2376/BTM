import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, type Config, type Seat } from '../src/config.ts';
import { openStore, type Store } from '../src/store/db.ts';
import { tmpRepo } from './helpers.ts';
import { git } from '../src/git.ts';
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
  });
});
