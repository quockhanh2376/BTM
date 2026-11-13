import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, realpathSync, existsSync, chmodSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { loadConfig, type Config, type Seat } from '../src/config.ts';
import { openStore, effectiveSeats, resolveSeats, type Store } from '../src/store/db.ts';
import { tmpRepo } from './helpers.ts';
import { git, commitAll, headSha } from '../src/git.ts';
import * as gitModule from '../src/git.ts';
import {
  runSession,
  resumeSession,
  type SessionOutcome,
  type SessionDeps,
} from '../src/core/session.ts';
import {
  pmTicketPrompt,
  devTicketPrompt,
  qcTicketPrompt,
} from '../src/core/prompts.ts';
import { createMonitor } from '../src/energy/monitor.ts';
import type { Ticket, TicketState } from '../src/ticket/ticket.ts';
import { snapshotTurn } from '../src/core/guard.ts';

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
  logFile?: string,
  options?: any
) => void | HandlerOutput | Promise<void | HandlerOutput>;

function createFakeRunner(steps: StepHandler[]) {
  const calls: Array<{ seat: Seat; agentId: string; prompt: string; cwd: string; logFile?: string; options?: any }> = [];
  let index = 0;
  const runner = async (seat: Seat, agentId: string, prompt: string, cwd: string, logFile?: string, options?: any) => {
    calls.push({ seat, agentId, prompt, cwd, logFile, options });
    if (index >= steps.length) {
      throw new Error(`Unexpected runner call #${index + 1} (${seat}/${agentId})`);
    }
    const handler = steps[index++];
    const res = await handler(seat, agentId, prompt, cwd, logFile, options);
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
  const projectYaml = join(repo, 'team', 'project.yaml');
  if (!existsSync(projectYaml)) {
    mkdirSync(join(repo, 'team'), { recursive: true });
    writeFileSync(projectYaml, 'key: GTM\n');
    try {
      commitAll(repo, 'init team/project.yaml', { name: 'core', email: 'core@btm.local' });
    } catch {}
  }

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

function writeTicketFile(cwd: string, t: Partial<Ticket> & { id: string; goal: string; number: number; of: number }) {
  mkdirSync(join(cwd, 'team', 'tickets'), { recursive: true });
  const content = `---
id: ${t.id}
goal: ${t.goal}
number: ${t.number}
of: ${t.of}
title: ${t.title ?? 'Test ticket ' + t.id}
type: ${t.type ?? 'feat'}
size: ${t.size ?? 'S'}
scope:
${(t.scope ?? ['src/app.ts']).map((s) => `  - ${s}`).join('\n')}
acceptance:
${(t.acceptance ?? ['ok']).map((a) => `  - ${a}`).join('\n')}
done_when: ${t.done_when ?? 'done'}
${t.depends_on && t.depends_on.length > 0 ? `depends_on:\n${t.depends_on.map((d) => `  - ${d}`).join('\n')}\n` : ''}${t.note ? `note: ${t.note}\n` : ''}${t.from_audit ? 'from_audit: true\n' : ''}---
# ${t.id}
`;
  writeFileSync(join(cwd, 'team', 'tickets', `${t.id}.md`), content);
}

function writeDevReport(cwd: string, t: { id: string; goal: string; number: number; of: number }, agentName = 'jacky', status = 'OK') {
  mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
  writeFileSync(
    join(cwd, 'team', 'reports', `${t.id}-dev.md`),
    `${t.id} · ${t.goal}#${t.number}/${t.of} · ${agentName}-Dev\n- Bug: không\n- Cần sửa: không\n- Cần xác nhận: ${status}\n`
  );
}

function makeQcResponse(
  t: { id: string; goal: string; number: number },
  verdict: 'pass' | 'fail' = 'pass',
  bugs: string[] = [],
  fix: string[] = [],
  confirm: string[] = verdict === 'pass' ? ['all good'] : []
) {
  return {
    lastMessage: JSON.stringify({
      ticket: t.id,
      goal: t.goal,
      number: t.number,
      verdict,
      bugs,
      fix,
      confirm,
    }),
  };
}

describe('Prompts for Tickets', () => {
  it('pmTicketPrompt contains goal, key, nextId, forbids commit/push, and instructs bare scope paths', () => {
    const prompt = pmTicketPrompt({ n: 1, title: 'Mục tiêu 1' }, 'GTM', 'GTM-0001');
    expect(prompt).toContain('Mục tiêu 1');
    expect(prompt).toContain('team/tickets/');
    expect(prompt).toContain('GTM-0001');
    expect(prompt).toContain('GTM');
    expect(prompt).toMatch(/cấm.*commit.*push/i);
    expect(prompt).toMatch(/đường dẫn trần/i);
  });

  it('devTicketPrompt is <= 6 lines, Vietnamese, mentions reading ticket file with acceptance, reports path, fix notes, merges newlines, forbids git commit and push, and lists allowed commands with restrictions', () => {
    const ticket: Ticket = {
      id: 'GTM-0001',
      goal: 'G1',
      number: 1,
      of: 1,
      title: 'Hiện thực\ntính năng',
      type: 'feat',
      size: 'S',
      scope: ['src/a.ts\n', 'src/b.ts'],
      acceptance: ['chạy được'],
      done_when: 'test pass\n',
      depends_on: [],
      from_audit: false,
    };
    const allowCommands = ['cat', 'ls', 'grep', 'git status', 'npx vitest'];
    const promptWithNotes = devTicketPrompt(ticket, 'Jacky', ['Lỗi syntax', 'out_of_scope:other.ts'], allowCommands);
    const lines = promptWithNotes.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(promptWithNotes).toContain('GTM-0001');
    expect(promptWithNotes).toContain('team/tickets/GTM-0001.md');
    expect(promptWithNotes).toContain('acceptance');
    expect(promptWithNotes).toContain('team/reports/GTM-0001-dev.md');
    expect(promptWithNotes).toContain('Lỗi syntax');
    expect(promptWithNotes).toContain('out_of_scope:other.ts');
    expect(promptWithNotes).toMatch(/cấm.*commit.*push/i);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('Hiện thực tính năng');
    expect(lines[1]).toContain('src/a.ts, src/b.ts');
    expect(promptWithNotes).toContain('cat, ls, grep, git status, npx vitest');
    expect(promptWithNotes).toContain('mỗi lệnh chạy riêng lẻ');
    expect(promptWithNotes).toContain('không nối &&/;/|');
    expect(promptWithNotes).toContain('không find/sed/rm');
    expect(promptWithNotes).toContain('đọc file bằng công cụ đọc file');

    const promptNoNotes = devTicketPrompt(ticket, 'Jacky', [], allowCommands);
    expect(promptNoNotes.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('qcTicketPrompt is <= 6 lines, Vietnamese, mentions reading ticket file with acceptance, merges newlines, forbids git commit and push, with JSON at the end', () => {
    const ticket: Ticket = {
      id: 'GTM-0001',
      goal: 'G1',
      number: 1,
      of: 1,
      title: 'Hiện thực\ntính năng',
      type: 'feat',
      size: 'S',
      scope: ['src/a.ts\n', 'src/b.ts'],
      acceptance: ['chạy được'],
      done_when: 'test pass\n',
      depends_on: [],
      from_audit: false,
    };
    const prompt = qcTicketPrompt(ticket, 'abc1234', 'Jenny');
    const lines = prompt.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(prompt).toContain('GTM-0001');
    expect(prompt).toContain('team/tickets/GTM-0001.md');
    expect(prompt).toContain('acceptance');
    expect(prompt).toContain('abc1234');
    expect(prompt).toMatch(/cấm.*commit.*push/i);
    expect(lines[0]).toContain('Hiện thực tính năng');
    expect(lines[2]).toContain('src/a.ts, src/b.ts');
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain('JSON QcResult đặt trong khối ```json ở cuối');
    expect(lastLine).toContain('{"verdict":"pass"|"fail"');
    expect(prompt).toContain('Core tự commit sau mỗi lượt Dev nên có commit sau base là bình thường');
    expect(prompt).toContain('file trong team/reports/ luôn được phép');
    expect(prompt).toContain('bỏ qua mọi tiêu chí về git/commit');
    expect(prompt).toContain('chỉ chấm sản phẩm theo acceptance');
  });

  it('pmTicketPrompt with notes instructs reading note and image and writing note: N-<id> in front matter', () => {
    const prompt = pmTicketPrompt(
      { n: 1, title: 'Team note N-1: Thêm nút' },
      'GTM',
      'GTM-0001',
      {
        notes: [{ notePath: 'team/inbox/N-1.md', imagePath: 'team/inbox/N-1.png', id: 'N-1' }],
      }
    );
    expect(prompt).toContain('team/inbox/N-1.md');
    expect(prompt).toContain('team/inbox/N-1.png');
    expect(prompt).toContain('note: N-1');
  });

  it('devTicketPrompt and qcTicketPrompt with ticket having note include note path and image instructions', () => {
    const ticket: Ticket = {
      id: 'GTM-0001',
      goal: 'G1',
      number: 1,
      of: 1,
      title: 'Thêm nút',
      type: 'feat',
      size: 'S',
      scope: ['src/a.ts'],
      acceptance: ['nút xuất hiện'],
      done_when: 'test pass',
      note: 'N-1',
      depends_on: [],
      from_audit: false,
    };
    const devP = devTicketPrompt(ticket, 'Jacky', [], ['cat', 'ls']);
    expect(devP).toContain('Đọc team/inbox/N-1.md và ảnh đính kèm; làm/chấm theo ảnh');

    const qcP = qcTicketPrompt(ticket, 'base123', 'Jenny');
    expect(qcP).toContain('Đọc team/inbox/N-1.md và ảnh đính kèm; làm/chấm theo ảnh');
  });
});

describe('Goal & Ticket Session Coordinator', () => {
  it('happy path: PM writes GTM-0001 -> Dev modifies scope + report -> QC passes', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      // PM
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, title: 'Add hello world' });
      },
      // Dev
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const hello = "world";\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      // QC
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Add hello world'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(outcome.sessionId).toBe(1);
    expect(outcome.tasks['GTM-0001']).toBe('passed');
    expect(calls.length).toBe(3);
    expect(calls[0].seat).toBe('pm');
    expect(calls[1].seat).toBe('dev');
    expect(calls[2].seat).toBe('qc');

    expect(store.countTurns(1)).toBe(3);
    expect(store.countTurns(1, 'pm')).toBe(1);
    expect(store.countTurns(1, 'dev')).toBe(1);
    expect(store.countTurns(1, 'qc')).toBe(1);

    store.close();
  });

  it('QC fail chỉ có "cần xác nhận" (không bug, không fix) → hỏi anh, không trả về Dev; anh trả lời + Resume → QC chạy lại', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);
    const seen: string[] = [];
    const confirm = ['Chạy npm start rồi mở localhost:3000 để xác nhận canvas. Sandbox chặn mở cổng (EPERM).'];
    const { runner } = createFakeRunner([
      (seat, _a, _p, cwd) => { seen.push(seat); writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }); },
      (seat, agent, _p, cwd) => { seen.push(seat); writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n'); writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent); },
      (seat) => { seen.push(seat); return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'fail', [], [], confirm); },
      (seat, _a, prompt) => { seen.push(seat); expect(prompt).toContain('Đã chạy, canvas hiện bình thường'); return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'); },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes[0]).toBe('questions_open:1');
    expect(store.getTicketState(repo, 'GTM-0001')?.state).toBe('awaiting_qc');
    expect(store.getTicketState(repo, 'GTM-0001')?.fix_rounds ?? 0).toBe(0);
    const q = store.listQuestions(repo, 'open');
    expect(q.map((x) => x.text)).toEqual(confirm);
    expect(q[0]!.seat).toBe('qc');

    store.answerQuestion(q[0]!.id, 'Đã chạy, canvas hiện bình thường');
    const resumed = await resumeSession(deps, outcome.sessionId!);
    expect(seen).toEqual(['pm', 'dev', 'qc', 'qc']);
    expect(store.getTicketState(repo, 'GTM-0001')?.state).toBe('passed');
    expect(resumed.status).not.toBe('needs_owner');
  });

  it('release.require_audit: thiếu ghế audit thì dừng audit_seat_missing (không bỏ qua audit); PM được dặn ticket docs', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const base = loadConfig('btm.config.yaml');
    const { deps, store } = makeDeps(repo, {
      seats: { ...base.seats, audit: '' },
      release: { require_audit: true, docs_ticket: true, github: {} },
    } as Partial<Config>);
    const { runner } = createFakeRunner([
      (_seat, _agent, prompt, cwd) => {
        expect(prompt).toContain('ticket tài liệu');
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, title: 'Only ticket' });
      },
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes).toContain('audit_seat_missing');
    expect(store.getGoal(repo, 1)?.state).toBe('qc_done');
    expect(existsSync(join(repo, 'team', 'goals', 'G1.md'))).toBe(false);
  });

  it('case 1: goal mới tạo branch goal/G1-<slug>, PM ghi 2 ticket -> Dev/QC chạy theo number, goal qc_done, có team/goals/G1.md, mọi commit started bằng GTM- hoặc G1:', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      // PM
      (_seat, _agent, prompt, cwd) => {
        expect(prompt).toContain('team/tickets/');
        expect(prompt).toContain('GTM-0001');
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2, title: 'First ticket' });
        writeTicketFile(cwd, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2, title: 'Second ticket' });
      },
      // Dev 1
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2 }, agent);
      },
      // QC 1
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
      // Dev 2
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2 }, agent);
      },
      // QC 2
      () => makeQcResponse({ id: 'GTM-0002', goal: 'G1', number: 2 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(outcome.sessionId).toBe(1);
    expect(outcome.tasks['GTM-0001']).toBe('passed');
    expect(outcome.tasks['GTM-0002']).toBe('passed');
    expect(calls.length).toBe(5);

    // Goal record in store
    const goal = store.getGoal(repo, 1);
    expect(goal).toBeDefined();
    expect(goal?.state).toBe('qc_done');
    expect(goal?.branch).toBe('goal/G1-build-feature');

    // team/goals/G1.md exists
    const goalMdPath = join(repo, 'team', 'goals', 'G1.md');
    expect(existsSync(goalMdPath)).toBe(true);
    const goalMd = readFileSync(goalMdPath, 'utf8');
    expect(goalMd).toContain('GTM-0001');
    expect(goalMd).toContain('GTM-0002');
    expect(goalMd).toContain('passed');

    // Check all commits in branch start with GTM- or G1:
    const commits = git(repo, 'log', '--oneline', 'main..goal/G1-build-feature').trim().split('\n');
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) {
      const subject = c.replace(/^[0-9a-f]+ /, '');
      expect(subject).toMatch(/^(GTM-\d+|G1:)/);
    }

    // Ticket states and history
    expect(store.getTicketState(repo, 'GTM-0001')?.state).toBe('passed');
    expect(store.getTicketState(repo, 'GTM-0002')?.state).toBe('passed');
    const h1 = store.ticketHistory(repo, 'GTM-0001');
    expect(h1.length).toBeGreaterThanOrEqual(3);

    store.close();
  });

  it('case 2: PM ghi ID trùng / sai KEY / ID < nextTicketSeq -> needs_owner, không lượt Dev', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);

    let devCalled = false;
    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'ABC-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => {
        devCalled = true;
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal with bad PM tickets'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(devCalled).toBe(false);
    expect(outcome.notes.some((n) => n.includes('load_tickets_failed') || n.includes('invalid') || n.includes('ABC') || n.includes('PM ticket error'))).toBe(true);

    store.close();
  });

  it('case 3: phiên 2 --goal-id G1 sau khi phiên 1 dừng sau ticket 1 -> chỉ chạy ticket 2, counter không reset', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo);

    let devCalledTickets: string[] = [];
    const abortCtl = new AbortController();

    const runner1 = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2, title: 'T1' });
        writeTicketFile(cwd, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2, title: 'T2' });
      },
      (_s, agent, _p, cwd) => {
        devCalledTickets.push('GTM-0001');
        writeFileSync(join(cwd, 'src', 'app.ts'), '1');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2 }, agent);
      },
      () => {
        abortCtl.abort();
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner1.runner;
    deps.signal = abortCtl.signal;

    const outcome1 = await runSession(deps, ['Continue goal'], { approved: true });
    expect(outcome1.status).toBe('stopped');
    expect(store.getTicketState(repo, 'GTM-0001')?.state).toBe('passed');
    expect(store.getTicketState(repo, 'GTM-0002')?.state).toBe('pending');
    expect(devCalledTickets).toEqual(['GTM-0001']);

    const deps2 = { ...deps, signal: undefined };
    let pmCalledInSession2 = false;
    const runner2 = createFakeRunner([
      (_s, agent, _p, cwd) => {
        devCalledTickets.push('GTM-0002');
        writeFileSync(join(cwd, 'src', 'app.ts'), '2');
        writeDevReport(cwd, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0002', goal: 'G1', number: 2 }, 'pass'),
    ]);
    deps2.runner = runner2.runner;

    const outcome2 = await runSession(deps2, [{ n: 1 }], { approved: true });
    expect(outcome2.status).toBe('done');
    expect(outcome2.tasks['GTM-0002']).toBe('passed');
    expect(devCalledTickets).toEqual(['GTM-0001', 'GTM-0002']);
    expect(pmCalledInSession2).toBe(false);

    const nextSeq = store.nextTicketSeq(repo);
    expect(nextSeq).toBeGreaterThanOrEqual(3);

    store.close();
  });

  it('case 4: ticket depends_on ticket failed -> blocked với not_ready', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo, {
      turn: {
        ...loadConfig('btm.config.yaml').turn,
        max_fix_rounds: 0,
      },
    });

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2, title: 'T1' });
        writeTicketFile(cwd, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2, title: 'T2', depends_on: ['GTM-0001'] });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'bad');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'fail', ['bug'], ['fix']),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Dependency test'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(store.getTicketState(repo, 'GTM-0001')?.state).toBe('failed');
    expect(store.getTicketState(repo, 'GTM-0002')?.state).toBe('blocked');
    expect(outcome.tasks['GTM-0002']).toBe('blocked');

    store.close();
  });

  it('case 5: hết lượt giữa goal -> out_of_turns', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo, {
      session: {
        ...loadConfig('btm.config.yaml').session,
        max_turns: 2,
      },
      energy: {
        ...loadConfig('btm.config.yaml').energy,
        reserve_turns_for_pm: 0,
      },
    });

    let qcCalled = false;
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'code');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        qcCalled = true;
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Turn limit test'], { approved: true });

    expect(outcome.status).toBe('out_of_turns');
    expect(qcCalled).toBe(false);

    // Resume phiên hết lượt: được hạn mức mới, chạy tiếp QC (không làm lại Dev).
    const resumed = await resumeSession(deps, outcome.sessionId);
    expect(qcCalled).toBe(true);
    expect(resumed.status).not.toBe('out_of_turns');
    expect(store.countTurns(outcome.sessionId)).toBe(1);

    store.close();
  });

  it('awaiting approval: approved: false stops after PM turn without calling Dev', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);

    let devCalled = false;
    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => {
        devCalled = true;
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Approval test'], { approved: false });

    expect(outcome.status).toBe('awaiting_approval');
    expect(devCalled).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0].seat).toBe('pm');

    store.close();
  });

  it('config require_task_approval=false và approved=false → bỏ qua approval, chạy tiếp tới Dev/QC và done', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo, {
      session: {
        ...loadConfig('btm.config.yaml').session,
        require_task_approval: false,
      },
    });

    const { runner, calls } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal 1'], { approved: false });

    expect(outcome.status).toBe('done');
    expect(outcome.sessionId).toBe(1);
    expect(calls.length).toBe(3);
    expect(calls[0].seat).toBe('pm');
    expect(calls[1].seat).toBe('dev');
    expect(calls[2].seat).toBe('qc');

    store.close();
  });

  it('PM out-of-scope edits (outside team/tickets/) -> needs_owner, unauthorized files not committed', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// original\n' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        writeFileSync(join(cwd, 'src', 'app.ts'), '// malicious PM edit\n');
        writeFileSync(join(cwd, 'evil.txt'), 'malicious\n');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['PM out of scope'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes.some((n) => n.includes('pm_out_of_scope'))).toBe(true);

    const lastCommitFiles = git(repo, 'log', '-1', '--name-only').trim().split('\n');
    expect(lastCommitFiles).not.toContain('src/app.ts');
    expect(lastCommitFiles).not.toContain('evil.txt');

    store.close();
  });

  it('QC modifies repo (dirty tree or commit) -> verdict forced fail (qc_modified_repo)', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo, {
      turn: {
        ...loadConfig('btm.config.yaml').turn,
        max_fix_rounds: 0,
      },
    });

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), '1');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'tampered.txt'), 'tampered by qc');
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['QC modifies repo test'], { approved: true });

    expect(outcome.tasks['GTM-0001']).toBe('failed');
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes[0]).toContain('qc_modified_repo');

    store.close();
  });

  it('gate reject then fix: round 1 Dev edits out of scope, round 2 fixes it in scope -> passes', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo);
    const recordSpy = vi.spyOn(store, 'recordHandoffFailure');

    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'outside.txt'), 'illegal');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      (_s, agent, prompt, cwd) => {
        expect(prompt).toContain('out_of_scope:outside.txt');
        git(cwd, 'rm', 'outside.txt');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Gate retry test'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(outcome.tasks['GTM-0001']).toBe('passed');
    expect(calls.length).toBe(4);
    expect(recordSpy).toHaveBeenCalledWith(1, 'GTM-0001', 'out_of_scope:outside.txt');

    store.close();
  });

  it('commit missing ticket id -> gate fails with commit_missing_ticket_id', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo, {
      turn: {
        ...loadConfig('btm.config.yaml').turn,
        max_fix_rounds: 0,
      },
    });

    // Tạo branch goal/G1-test và commit ticket GTM-0001
    git(repo, 'checkout', '-b', 'goal/G1-test', 'main');
    writeTicketFile(repo, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
    commitAll(repo, 'GTM-0001: ticket', { name: 'pm', email: 'pm@btm.local' });

    const baseSha = headSha(repo);
    store.upsertTicket(repo, {
      id: 'GTM-0001',
      goal: 'G1',
      number: 1,
      of: 1,
      title: 'T1',
      type: 'feat',
      size: 'S',
      scope: ['src/app.ts'],
      acceptance: ['ok'],
      done_when: 'done',
      depends_on: [],
      from_audit: false,
    });
    store.setTicketState(repo, 'GTM-0001', 'in_dev', 'dev', 'start', 0, baseSha);

    // Tạo commit không có ticket ID giữa base và HEAD
    writeFileSync(join(repo, 'extra.txt'), 'extra');
    commitAll(repo, 'commit without ticket id', { name: 'core', email: 'core@btm.local' });

    git(repo, 'checkout', 'main');

    const { runner } = createFakeRunner([
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev edit');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Test'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes.some((n) => n.includes('commit_missing_ticket_id'))).toBe(true);

    store.close();
  });

  it('report header invalid -> gate fails with report_header_invalid', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo, {
      turn: {
        ...loadConfig('btm.config.yaml').turn,
        max_fix_rounds: 0,
      },
    });

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev edit');
        mkdirSync(join(cwd, 'team', 'reports'), { recursive: true });
        writeFileSync(join(cwd, 'team', 'reports', 'GTM-0001-dev.md'), 'OK\nJust plain text\n');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Invalid report header test'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes.some((n) => n.includes('report_header_invalid'))).toBe(true);

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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        qcCalled = true;
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });
    expect(outcome.status).toBe('needs_owner');
    expect(recordSpy).toHaveBeenCalledWith(1, 'GTM-0001', 'empty_diff');
    expect(qcCalled).toBe(false);

    store.close();
  });

  it('gate rớt còn vòng → returned (fix_rounds: 1); hết vòng → failed; BLOCKED → blocked', async () => {
    // 1. BLOCKED -> blocked
    const repoBlocked = tmpRepo({ 'src/app.ts': '1' });
    const { deps: depsBlocked, store: storeBlocked } = makeDeps(repoBlocked);
    const { runner: runnerBlocked } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => ({
        lastMessage: 'BLOCKED: dependencies missing',
      }),
    ]);
    depsBlocked.runner = runnerBlocked;
    const outcomeBlocked = await runSession(depsBlocked, ['Goal 1'], { approved: true });
    expect(outcomeBlocked.tasks['GTM-0001']).toBe('blocked');
    storeBlocked.close();

    // 2. gate fails -> returned with fixRounds: 1
    const repoGate = tmpRepo({ 'src/app.ts': '1' });
    const { deps: depsGate, store: storeGate } = makeDeps(repoGate);
    const { runner: runnerGate } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'out.txt'), 'bad');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      (_s, agent, _p, cwd) => {
        git(cwd, 'rm', 'out.txt');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    depsGate.runner = runnerGate;
    const outcomeGate = await runSession(depsGate, ['Goal 1'], { approved: true });
    expect(outcomeGate.status).toBe('done');
    expect(storeGate.ticketHistory(repoGate, 'GTM-0001').some((h) => h.to_state === 'returned')).toBe(true);
    storeGate.close();

    // 3. gate exceeds max_fix_rounds -> failed
    const repoExceed = tmpRepo({ 'src/app.ts': '1' });
    const { deps: depsExceed, store: storeExceed } = makeDeps(repoExceed, {
      turn: {
        ...loadConfig('btm.config.yaml').turn,
        max_fix_rounds: 0,
      },
    });
    const { runner: runnerExceed } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'out.txt'), 'bad');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
    ]);
    depsExceed.runner = runnerExceed;
    const outcomeExceed = await runSession(depsExceed, ['Goal 1'], { approved: true });
    expect(outcomeExceed.tasks['GTM-0001']).toBe('failed');
    storeExceed.close();
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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev 1');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'fail', ['bug 1'], ['fix 1']),
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev 2');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'fail', ['bug 2'], ['fix 2']),
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev 3');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'fail', ['bug 3'], ['fix 3']),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Fix bug'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.tasks['GTM-0001']).toBe('failed');
    expect(calls.length).toBe(7);

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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), '2');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'fail', ['still broken'], []),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('out_of_turns');
    expect(calls.length).toBe(3);
    expect(store.countTurns(1)).toBe(3);

    store.close();
  });

  it('hết lượt theo ghế: dev exceeds max_turns_per_seat.dev -> out_of_turns', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      session: {
        ...loadConfig('btm.config.yaml').session,
        max_turns_per_seat: {
          ...loadConfig('btm.config.yaml').session.max_turns_per_seat,
          dev: 1,
        },
      },
    });

    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'outside.txt'), 'bad');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('out_of_turns');
    expect(calls.length).toBe(1);
    expect(store.countTurns(1)).toBe(1);

    store.close();
  });

  it('Rule 8: coder cannot QC same ticket -> coder_cannot_qc_same_task and needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo, {
      seats: {
        ...loadConfig('btm.config.yaml').seats,
        pm: 'elon',
        dev: 'jenny',
        qc: 'jenny',
      },
    });

    let qcRan = false;
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), '1');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        qcRan = true;
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Rule 8 conflict test'], { approved: true });

    expect(qcRan).toBe(false);
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes.some((n) => n.includes('coder_cannot_qc_same_task'))).toBe(true);

    store.close();
  });

  it('đổi coder giữa vòng: coder_cannot_qc stops when QC matches ANY agent that coded the ticket', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      seats: {
        ...loadConfig('btm.config.yaml').seats,
        pm: 'elon',
        dev: 'alice',
        qc: 'alice',
      },
      rules: {
        ...loadConfig('btm.config.yaml').rules,
        coder_cannot_qc_same_task: true,
      },
    });

    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'outside.txt'), 'bad');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        deps.cfg.seats.dev = 'bob';
      },
      (_s, agent, _p, cwd) => {
        git(cwd, 'rm', 'outside.txt');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(calls.length).toBe(3);
    expect(outcome.notes[0]).toContain("who also coded task 'GTM-0001'");

    store.close();
  });

  it('author commit = agent dev: commits created by Dev use Dev agent identity', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, {
      seats: {
        ...loadConfig('btm.config.yaml').seats,
        pm: 'elon',
        dev: 'custom-dev',
        qc: 'jenny',
      },
    });

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'custom work');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });
    expect(outcome.status).toBe('done');

    const devAuthorLine = git(repo, 'log', '-1', '--format=%an <%ae>', 'goal/G1-goal~2').trim();
    expect(devAuthorLine).toBe('custom-dev <custom-dev@btm.local>');
    const qcAuthorLine = git(repo, 'log', '-1', '--format=%an <%ae>', 'goal/G1-goal~1').trim();
    expect(qcAuthorLine).toBe('jenny <jenny@btm.local>');

    store.close();
  });

  it('effectiveSeats returns cfg.seats by default and overridden seat from store setting', () => {
    const repo = tmpRepo({});
    const { store, cfg } = makeDeps(repo);
    const eff1 = effectiveSeats(cfg, store);
    expect(eff1).toEqual(cfg.seats);

    store.setSetting('seat:dev', 'jenny');
    const eff2 = effectiveSeats(cfg, store);
    expect(eff2.dev).toBe('jenny');
    expect(eff2.pm).toBe(cfg.seats.pm);
    expect(eff2.qc).toBe(cfg.seats.qc);
    store.close();
  });

  it('effectiveSeats ignores override if agent not in cfg.agents or can_sit does not contain seat, and warns', () => {
    const repo = tmpRepo({});
    const { store, cfg } = makeDeps(repo);

    store.setSetting('seat:dev', 'unknown_agent');
    expect(effectiveSeats(cfg, store).dev).toBe(cfg.seats.dev);
    expect(resolveSeats(cfg, store).warnings.join(' ')).toContain('unknown_agent');

    store.setSetting('seat:dev', 'elon');
    expect(effectiveSeats(cfg, store).dev).toBe(cfg.seats.dev);
    expect(resolveSeats(cfg, store).warnings.join(' ')).toContain('"elon"');

    for (const dangerous of ['__proto__', 'constructor', 'toString']) {
      store.setSetting('seat:dev', dangerous);
      expect(effectiveSeats(cfg, store).dev).toBe(cfg.seats.dev);
    }

    store.close();
  });

  it('when dev is swapped to jenny: next dev turn calls runner with jenny', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    store.setSetting('seat:dev', 'jenny');
    store.setSetting('seat:qc', 'elon');

    let devAgentCalled = '';
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        devAgentCalled = agent;
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev done');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Test seat swap'], { approved: true });
    expect(outcome.status).toBe('done');
    expect(devAgentCalled).toBe('jenny');
    store.close();
  });

  it('when jenny coded ticket and qc is also jenny: QC fails with coder_cannot_qc_same_task and needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store, cfg } = makeDeps(repo);
    store.setSetting('seat:dev', 'jenny');
    expect(cfg.seats.qc).toBe('jenny');

    let qcRan = false;
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev done');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        qcRan = true;
        return { exitCode: 0, output: 'QC run' };
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Test coder cannot qc'], { approved: true });
    expect(qcRan).toBe(false);
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes).toContain('coder_cannot_qc_same_task');
    const failures = store.listHandoffFailures(outcome.sessionId!);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].reason).toBe('coder_cannot_qc_same_task');
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

  it('timeout makes WIP commit: Dev timedOut: true -> WIP GTM-0001 commit, needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
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

    const lastCommitMsg = git(repo, 'log', '-1', '--pretty=%B', 'goal/G1-goal').trim();
    expect(lastCommitMsg).toContain('GTM-0001: WIP');

    store.close();
  });

  it('invalid QC output: prose instead of JSON -> fail with qc_output_invalid', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => ({
        lastMessage: 'Tôi thấy code trông khá ổn nhưng không có JSON.',
      }),
      (_s, agent, prompt, cwd) => {
        expect(prompt).toContain('qc_output_invalid');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev fixed');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(outcome.tasks['GTM-0001']).toBe('passed');
    expect(calls.length).toBe(5);

    store.close();
  });

  it('Dev reports BLOCKED -> ticket blocked, needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => ({
        output: 'Cannot proceed. BLOCKED: missing dependencies.',
        lastMessage: 'BLOCKED: missing dependencies.',
      }),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(outcome.tasks['GTM-0001']).toBe('blocked');

    store.close();
  });

  it('FIX-E B5: Dev BLOCKED sửa ticket → khôi phục ticket từ base, chỉ commit phần còn lại với <ID>: blocked', async () => {
    const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, {
          id: 'GTM-0001',
          goal: 'G1',
          number: 1,
          of: 1,
          title: 'Original title',
        });
      },
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
        writeTicketFile(cwd, {
          id: 'GTM-0001',
          goal: 'G1',
          number: 1,
          of: 1,
          title: 'Tampered title',
        });
        return { lastMessage: 'BLOCKED: owner input required' };
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Blocked ticket tamper'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    const ticketText = readFileSync(join(repo, 'team', 'tickets', 'GTM-0001.md'), 'utf8');
    expect(ticketText).toContain('Original title');
    expect(ticketText).not.toContain('Tampered title');
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'export const a = 1;\n'
    );
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('GTM-0001: blocked');
    expect(git(repo, 'diff', 'HEAD~1', 'HEAD', '--', 'team/tickets').trim()).toBe('');

    store.close();
  });

  it('FIX-E B9: runSession từ chối goal approved/merged, giữ nguyên state và không tạo session', async () => {
    const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
    const { deps, store } = makeDeps(repo);
    const approved = store.createGoal(repo, 'Approved goal');
    const merged = store.createGoal(repo, 'Merged goal');
    store.setGoalState(repo, approved.n, 'approved', 'owner');
    store.setGoalState(repo, merged.n, 'merged', 'owner');
    const runner = vi.fn();
    deps.runner = runner;

    for (const goal of [approved, merged]) {
      const before = store.getGoal(repo, goal.n)?.state;
      const outcome = await runSession(deps, [{ n: goal.n }], { approved: true });
      expect(outcome).toMatchObject({
        status: 'needs_owner',
        sessionId: null,
        notes: ['goal_already_merged'],
      });
      expect(store.getGoal(repo, goal.n)?.state).toBe(before);
    }
    expect(store.getLatestSession(undefined, repo)).toBeNull();
    expect(runner).not.toHaveBeenCalled();

    store.close();
  });

  it('PM creates invalid ticket (TicketError) -> needs_owner', async () => {
    const repo = tmpRepo({});
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        mkdirSync(join(cwd, 'team', 'tickets'), { recursive: true });
        writeFileSync(
          join(cwd, 'team', 'tickets', 'GTM-0001.md'),
          `---
id: GTM-0001
goal: G1
number: 1
of: 1
title: Invalid ticket
type: feat
size: S
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

  it('Runner throw: dev runner throws -> endTurn("error"), commit WIP, needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const endTurnSpy = vi.spyOn(store, 'endTurn');

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
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

    const lastCommitMsg = git(repo, 'log', '-1', '--pretty=%B', 'goal/G1-goal').trim();
    expect(lastCommitMsg).toContain('GTM-0001: WIP');
    expect(lastCommitMsg).toContain('Agent process killed unexpectedly');

    store.close();
  });

  it('Lượt thành công chỉ khi exitCode===0 và !timedOut: non-zero exitCode triggers error turn and needs_owner', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const endTurnSpy = vi.spyOn(store, 'endTurn');

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
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

    const lastCommitMsg = git(repo, 'log', '-1', '--pretty=%B', 'goal/G1-goal').trim();
    expect(lastCommitMsg).toContain('GTM-0001: WIP exit_127');

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
    const dbPath = join(tmpdir(), `test-store-1428-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const customStore = openStore(dbPath);
    const { deps } = makeDeps(repo);
    deps.store.close();
    deps.store = customStore;

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'dev done');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        writeFileSync(join(cwd, '.git', 'index.lock'), '');
      },
    ]);
    deps.runner = runner;

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
    const dbPath = join(tmpdir(), `test-store-1476-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const customStore = openStore(dbPath);
    const { deps } = makeDeps(repo);
    deps.store.close();
    deps.store = customStore;

    let qcCalled = false;
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, _a, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'wip');
        return {
          exitCode: null,
          timedOut: false,
          output: 'Killed by SIGKILL',
        };
      },
      () => {
        qcCalled = true;
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
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

  it('khi PM bị abort hoặc timeout: dọn sạch team/tickets/, working tree sạch, không commit ticket dở dang', async () => {
    // Subtest 1: Abort
    const repoAbort = tmpRepo({ 'src/app.ts': '1' });
    const { deps: depsAbort, store: storeAbort } = makeDeps(repoAbort);
    const abortCtrl = new AbortController();
    depsAbort.signal = abortCtrl.signal;

    depsAbort.runner = async (_seat, _agent, _prompt, cwd) => {
      mkdirSync(join(cwd, 'team', 'tickets'), { recursive: true });
      writeFileSync(join(cwd, 'team', 'tickets', 'draft.md'), 'draft ticket');
      abortCtrl.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };

    const outcomeAbort = await runSession(depsAbort, ['Goal 1'], { approved: true });
    expect(outcomeAbort.status).toBe('stopped');
    expect(git(repoAbort, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(join(repoAbort, 'team', 'tickets', 'draft.md'))).toBe(false);
    const lastCommitAbort = git(repoAbort, 'log', '-1', '--pretty=%B').trim();
    expect(lastCommitAbort).not.toMatch(/^G1: WIP/);
    storeAbort.close();

    // Subtest 2: Timeout
    const repoTimeout = tmpRepo({ 'src/app.ts': '1' });
    const { deps: depsTimeout, store: storeTimeout } = makeDeps(repoTimeout);
    depsTimeout.runner = async (_seat, _agent, _prompt, cwd) => {
      mkdirSync(join(cwd, 'team', 'tickets'), { recursive: true });
      writeFileSync(join(cwd, 'team', 'tickets', 'draft.md'), 'draft timeout');
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
    expect(git(repoTimeout, 'status', '--porcelain').trim()).toBe('');
    expect(existsSync(join(repoTimeout, 'team', 'tickets', 'draft.md'))).toBe(false);
    const lastCommitTimeout = git(repoTimeout, 'log', '-1', '--pretty=%B').trim();
    expect(lastCommitTimeout).not.toMatch(/^G1: WIP/);
    storeTimeout.close();
  });

  it('đầu phiên working tree bẩn → trả needs_owner note dirty_tree_at_start, không commit', async () => {
    const repo = tmpRepo({ 'src/app.ts': 'initial' });
    const { deps, store } = makeDeps(repo);
    writeFileSync(join(repo, 'src', 'app.ts'), 'dirty before session');
    writeFileSync(join(repo, 'dirty-untracked.txt'), 'hello');
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
    ]);

    deps.runner = runner;
    const outcome = await runSession(deps, ['Goal 1'], { approved: true });
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes.some((n) => n.includes('dirty_tree_at_start'))).toBe(true);
    expect(outcome.notes.some((n) => n.includes('main'))).toBe(true);

    const baseBranch = deps.cfg.git.protected_branch || 'main';
    const mainLog = git(repo, 'log', baseBranch, '-n', '2', '--pretty=%s');
    expect(mainLog).not.toContain('checkpoint');
    store.close();
  });

  it('session passes cfg.runner.agy_allow_commands into devTicketPrompt', async () => {
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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, prompt, cwd) => {
        devPromptReceived = prompt;
        writeFileSync(join(cwd, 'src', 'app.ts'), '2');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => ({
        exitCode: 0,
        output: 'tool bash: auto-denied command "find . -name *.ts"',
        lastMessage: 'auto-denied',
      }),
      (_s, agent, prompt, cwd) => {
        devRound2Prompt = prompt;
        writeFileSync(join(cwd, 'src', 'app.ts'), '2');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.notes).toEqual([]);
    expect(outcome.status).toBe('done');
    expect(outcome.tasks['GTM-0001']).toBe('passed');
    expect(calls.length).toBe(4);

    expect(recordSpy).toHaveBeenCalledWith(1, 'GTM-0001', 'command_denied');
    expect(devRound2Prompt).toContain('command_denied: use only allowed commands, one per call');

    store.close();
  });

  it('Dev output containing auto-denied with non-zero exit code is handled as command_denied fix round', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const recordSpy = vi.spyOn(store, 'recordHandoffFailure');

    let devRound2Prompt = '';
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => ({
        exitCode: 1,
        output: 'Error: auto-denied tool execution outside whitelist',
        lastMessage: 'Terminated',
      }),
      (_s, agent, prompt, cwd) => {
        devRound2Prompt = prompt;
        writeFileSync(join(cwd, 'src', 'app.ts'), '2');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal'], { approved: true });

    expect(outcome.notes).toEqual([]);
    expect(outcome.status).toBe('done');
    expect(outcome.tasks['GTM-0001']).toBe('passed');
    expect(recordSpy).toHaveBeenCalledWith(1, 'GTM-0001', 'command_denied');
    expect(devRound2Prompt).toContain('command_denied: use only allowed commands, one per call');

    store.close();
  });

  it('happy path ghi đúng chuỗi pending → in_dev → awaiting_qc → passed', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), '// dev\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal 1'], { approved: true });
    expect(outcome.notes).toEqual([]);
    expect(outcome.status).toBe('done');

    const history = store.ticketHistory(repo, 'GTM-0001');
    const states = history.map((h) => h.to_state);
    expect(states).toContain('pending');
    expect(states).toContain('in_dev');
    expect(states).toContain('awaiting_qc');
    expect(states).toContain('passed');

    store.close();
  });

  it('QC rớt một lần → có returned với fix_rounds: 1 rồi passed', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), '// dev 1\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'fail', ['bug 1'], ['fix 1']),
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), '// dev 2\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal 1'], { approved: true });
    expect(outcome.notes).toEqual([]);
    expect(outcome.status).toBe('done');

    const history = store.ticketHistory(repo, 'GTM-0001');
    const returnedEntry = history.find((h) => h.to_state === 'returned');
    expect(returnedEntry).toBeDefined();

    const finalState = store.getTicketState(repo, 'GTM-0001');
    expect(finalState?.state).toBe('passed');
    expect(finalState?.fix_rounds).toBe(1);

    store.close();
  });

  it('mỗi lượt có log_file = <logDir>/turn-<id>.log trước khi runner được gọi (runner giả đọc listTurns thấy đã có)', async () => {
    const repo = tmpRepo({ 'src/app.ts': '// initial\n' });
    const { deps, store } = makeDeps(repo);

    const observedLogFilesDuringRunnerCalls: string[] = [];
    const runnerLogFileArgs: string[] = [];

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd, logFile) => {
        runnerLogFileArgs.push(logFile || '');
        const turns = store.listTurns(1);
        expect(turns.length).toBe(1);
        const currentTurn = turns[0];
        expect(currentTurn.log_file).toBe(join(deps.logDir, `turn-${currentTurn.id}.log`));
        observedLogFilesDuringRunnerCalls.push(currentTurn.log_file!);

        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd, logFile) => {
        runnerLogFileArgs.push(logFile || '');
        const turns = store.listTurns(1);
        expect(turns.length).toBe(2);
        const currentTurn = turns[1];
        expect(currentTurn.log_file).toBe(join(deps.logDir, `turn-${currentTurn.id}.log`));
        observedLogFilesDuringRunnerCalls.push(currentTurn.log_file!);

        writeFileSync(join(cwd, 'src', 'app.ts'), '// dev\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      (_s, _a, _p, _cwd, logFile) => {
        runnerLogFileArgs.push(logFile || '');
        const turns = store.listTurns(1);
        expect(turns.length).toBe(3);
        const currentTurn = turns[2];
        expect(currentTurn.log_file).toBe(join(deps.logDir, `turn-${currentTurn.id}.log`));
        observedLogFilesDuringRunnerCalls.push(currentTurn.log_file!);

        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Goal 1'], { approved: true });
    expect(outcome.notes).toEqual([]);
    expect(outcome.status).toBe('done');

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

    store.close();
  });

  it('handoff: prompt bàn giao xuất hiện khi Dev của ticket đang returned khác agent đã code trước', async () => {
    const repo = tmpRepo({ 'src/app.ts': '0' });
    const { deps, store } = makeDeps(repo);

    let round2Prompt = '';
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'outside.txt'), 'illegal');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        deps.cfg.seats.dev = 'jenny';
        deps.cfg.seats.qc = 'elon';
      },
      (_s, agent, prompt, cwd) => {
        round2Prompt = prompt;
        git(cwd, 'rm', 'outside.txt');
        writeFileSync(join(cwd, 'src', 'app.ts'), 'fixed');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(deps, ['Handoff prompt test'], { approved: true });

    expect(outcome.status).toBe('done');
    expect(round2Prompt).toContain('Bàn giao: đọc git log nhánh phiên và team/reports/GTM-0001-dev.md trước khi sửa');

    store.close();
  });

  it('devTicketPrompt includes handoff instruction when handoff is true and omits it when false', () => {
    const ticket: Ticket = {
      id: 'GTM-0001',
      goal: 'G1',
      number: 1,
      of: 1,
      title: 'Handoff test',
      type: 'feat',
      size: 'S',
      scope: ['src/a.ts'],
      acceptance: ['done'],
      done_when: 'ok',
      depends_on: [],
      from_audit: false,
    };
    const pNormal = devTicketPrompt(ticket, 'Jacky', [], ['cat', 'ls']);
    expect(pNormal).not.toContain('Bàn giao:');

    const pHandoff = devTicketPrompt(ticket, 'Jacky', [], ['cat', 'ls'], true);
    expect(pHandoff).toContain('Bàn giao: đọc git log nhánh phiên và team/reports/GTM-0001-dev.md trước khi sửa');
  });

  it('phiên done + ticket passed → note done; khác → needs_owner, note open', async () => {
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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, note: 'N-1' });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;

    const outcome = await runSession(
      deps,
      ['Team note N-1: Yêu cầu cập nhật nút'],
      { approved: true, noteId }
    );

    expect(outcome.notes).toEqual([]);
    expect(outcome.status).toBe('done');
    expect(outcome.tasks['GTM-0001']).toBe('passed');

    const noteAfter = store.getNote(noteId);
    expect(noteAfter?.status).toBe('done');

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
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, note: 'N-1' });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        chmodSync(notePath, 0o444);
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;

    try {
      const outcome = await runSession(
        deps,
        ['Team note N-1: Yêu cầu cập nhật nút'],
        { approved: true, noteId }
      );

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes.some((n) => n.includes('close') || n.includes('EACCES') || n.includes('EPERM'))).toBe(true);

      const noteAfter = store.getNote(noteId);
      expect(noteAfter?.status).toBe('open');
    } finally {
      chmodSync(notePath, 0o644);
      store.close();
    }
  });

  it('commit đóng note lỗi → khôi phục file về status: open (git checkout file) rồi needs_owner', async () => {
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
        git(repoArg, 'add', '-A');
        throw new Error('Simulated git commit error on close note after stage');
      }
      return origCommitAll(repoArg, msg, author);
    });

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, note: 'N-1' });
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);

    deps.runner = runner;

    try {
      const outcome = await runSession(deps, ['Mục tiêu test commit close note fail'], {
        approved: true,
        noteId,
      });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes.some((n) => n.includes('close note N-1 error'))).toBe(true);

      const fileContent = readFileSync(notePath, 'utf8');
      expect(fileContent).toContain('status: open');
      expect(fileContent).not.toContain('status: done');

      const diffCached = git(repo, 'diff', '--cached', '--name-only');
      expect(diffCached).not.toContain('team/inbox/N-1.md');

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

    const noteId = store.createNote(repo, 'Fix UI bug with image', 'N-1.png');
    const inboxDir = join(repo, 'team', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'N-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(
      join(inboxDir, 'N-1.md'),
      `---\nid: N-1\nfrom: owner\nstatus: open\nat: 2026-11-08T08:00:00.000Z\nimage: N-1.png\n---\nFix UI bug with image\n`
    );
    commitAll(repo, 'inbox N-1', { name: 'owner', email: 'owner@btm.local' });

    let capturedQcOptions: any;

    deps.runner = async (seat, agentId, prompt, cwd, logFile, options) => {
      if (seat === 'pm') {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, note: 'N-1' });
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
      }
      if (seat === 'dev') {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agentId);
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
      }
      if (seat === 'qc') {
        capturedQcOptions = options;
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', ...makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass') };
      }
      return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: '' };
    };

    const outcome = await runSession(deps, ['Work on GTM-0001'], { approved: true, noteId });
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

    const note1 = store.createNote(repo, 'Note for current repo');
    const inboxDir = join(repo, 'team', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      join(inboxDir, `N-${note1}.md`),
      `---\nid: N-${note1}\nfrom: owner\nstatus: open\nat: 2026-11-08T08:00:00.000Z\n---\nNote for current repo\n`
    );
    commitAll(repo, 'inbox note 1', { name: 'owner', email: 'owner@btm.local' });

    const note2 = store.createNote(otherRepo, 'Note for other repo');

    let currentNoteForPm: number | undefined;
    let seqCounter = 0;

    deps.runner = async (seat, agentId, _prompt, cwd) => {
      if (seat === 'pm') {
        seqCounter++;
        const gNum = seqCounter;
        const tId = `GTM-${String(seqCounter).padStart(4, '0')}`;
        writeTicketFile(cwd, {
          id: tId,
          goal: `G${gNum}`,
          number: 1,
          of: 1,
          note: currentNoteForPm ? `N-${currentNoteForPm}` : undefined,
        });
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
      }
      if (seat === 'dev') {
        const tId = `GTM-${String(seqCounter).padStart(4, '0')}`;
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const x = 2;\n');
        writeDevReport(cwd, { id: tId, goal: `G${seqCounter}`, number: 1, of: 1 }, agentId);
        return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: 'done' };
      }
      if (seat === 'qc') {
        const tId = `GTM-${String(seqCounter).padStart(4, '0')}`;
        return {
          exitCode: 0,
          timedOut: false,
          durationMs: 10,
          output: '',
          ...makeQcResponse({ id: tId, goal: `G${seqCounter}`, number: 1 }, 'pass'),
        };
      }
      return { exitCode: 0, timedOut: false, durationMs: 10, output: '', lastMessage: '' };
    };

    currentNoteForPm = undefined;
    const outcome1 = await runSession(deps, [`Team note N-${note1}: Lỗi`], { approved: true });
    expect(outcome1.status).toBe('done');
    const session1Notes = store.getNotesBySession(outcome1.sessionId!);
    expect(session1Notes.length).toBe(0);

    currentNoteForPm = undefined;
    const outcome2 = await runSession(deps, ['Fix task with note2'], { approved: true, noteId: note2 });
    expect(outcome2.status).toBe('done');
    const session2Notes = store.getNotesBySession(outcome2.sessionId!);
    expect(session2Notes.length).toBe(0);

    currentNoteForPm = note1;
    const outcome3 = await runSession(deps, ['Fix task with note1'], { approved: true, noteId: note1 });
    expect(outcome3.status).toBe('done');
    const session3Notes = store.getNotesBySession(outcome3.sessionId!);
    expect(session3Notes.length).toBe(1);
    expect(session3Notes[0].id).toBe(note1);

    store.close();
  });

  it('lỗi ghi note/ảnh trong runSession → xóa file vừa ghi, xóa bản ghi note, phiên needs_owner', async () => {
    const repo = tmpRepo({
      'src/app.ts': 'export const x = 1;\n',
    });
    const { deps, store } = makeDeps(repo);

    const inboxDir = join(repo, 'team', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'N-1.png'), 'existing note file on main');
    commitAll(repo, 'pre-existing N-1.png', { name: 'owner', email: 'owner@btm.local' });

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
      [`Team note N-${noteId}: Lỗi va chạm file`],
      {
        approved: true,
        noteId,
        text: 'Lỗi va chạm file',
        image: { ext: 'png', bytes: Buffer.from([1, 2, 3]) },
      }
    );

    expect(outcome.status).toBe('needs_owner');
    expect(pmCalled).toBe(false);

    expect(store.getNote(noteId)).toBeNull();

    store.close();
  });

  it('lỗi commitAll inbox note trong runSession → xóa file vừa ghi, xóa bản ghi note, phiên needs_owner', async () => {
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
        [`Team note N-${noteId}: Test commit error`],
        {
          approved: true,
          noteId,
          text: 'Test commit error',
          image: { ext: 'png', bytes: pngBuf },
        }
      );

      expect(outcome.status).toBe('needs_owner');
      expect(pmCalled).toBe(false);

      const mdPath = join(repo, 'team', 'inbox', `N-${noteId}.md`);
      const imgPath = join(repo, 'team', 'inbox', `N-${noteId}.png`);
      expect(existsSync(mdPath)).toBe(false);
      expect(existsSync(imgPath)).toBe(false);

      expect(store.getNote(noteId)).toBeNull();
    } finally {
      commitSpy.mockRestore();
      store.close();
    }
  });

  it('energy 15% với ngưỡng 20 → lượt Dev không chạy, needs_owner, note có "hồi lúc"', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    let devCalled = false;
    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
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

    deps.runner = runner;
    deps.gate = gate;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    expect(outcome.status).toBe('needs_owner');
    expect(devCalled).toBe(false);
    expect(outcome.notes.some((n) => n.includes('hồi lúc'))).toBe(true);
    expect(outcome.notes).toContain('energy:5h còn 15%, hồi lúc 19:57');

    const failures = store.listHandoffFailures(outcome.sessionId!);
    expect(failures).toHaveLength(1);
    expect(failures[0].task_id).toBe('GTM-0001');
    expect(failures[0].reason).toBe('energy:5h còn 15%, hồi lúc 19:57');

    store.close();
  });

  it('energy unknown → chạy bình thường', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    let devCalled = false;
    let qcCalled = false;
    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_seat, agent, _prompt, cwd) => {
        devCalled = true;
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        qcCalled = true;
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);

    const gate = vi.fn(() => ({ ok: true as const }));
    deps.runner = runner;
    deps.gate = gate;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    expect(devCalled).toBe(true);
    expect(qcCalled).toBe(true);
    expect(outcome.status).toBe('done');

    store.close();
  });

  it('login relogin cho QC → Dev vẫn chạy, tới QC thì dừng', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    let devCalled = false;
    let qcCalled = false;
    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_seat, agent, _prompt, cwd) => {
        devCalled = true;
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        qcCalled = true;
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);

    const gate = vi.fn((agent: string) => {
      if (agent === 'jenny') {
        return { ok: false as const, reason: 'login:relogin' };
      }
      return { ok: true as const };
    });

    deps.runner = runner;
    deps.gate = gate;

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    expect(devCalled).toBe(true);
    expect(qcCalled).toBe(false);
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes).toContain('login:relogin');

    const failures = store.listHandoffFailures(outcome.sessionId!);
    expect(failures).toHaveLength(1);
    expect(failures[0].task_id).toBe('GTM-0001');
    expect(failures[0].reason).toBe('login:relogin');

    store.close();
  });

  it('gọi refresh(mọi agent đang ngồi ghế) khi mở phiên và refresh([agent]) trước mỗi lượt', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);

    const refreshCalls: string[][] = [];
    const refresh = vi.fn(async (agents: string[]) => {
      refreshCalls.push(agents);
    });

    deps.runner = runner;
    deps.refresh = refresh;
    deps.gate = () => ({ ok: true as const });

    await runSession(deps, ['Build feature'], { approved: true });

    expect(refreshCalls[0]).toEqual(expect.arrayContaining(['elon', 'jacky', 'jenny']));
    expect(refreshCalls).toContainEqual(['elon']);
    expect(refreshCalls).toContainEqual(['jacky']);
    expect(refreshCalls).toContainEqual(['jenny']);

    store.close();
  });

  it('refresh reject khi mở phiên -> coi như unknown, phiên tiếp tục bình thường và setSessionStatus được gọi', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);

    const refresh = vi.fn().mockRejectedValue(new Error('Network offline reading quota'));

    deps.runner = runner;
    deps.refresh = refresh;
    deps.gate = () => ({ ok: true as const });

    const outcome = await runSession(deps, ['Build feature'], { approved: true });

    expect(outcome.status).toBe('done');
    const session = store.getSession(outcome.sessionId!);
    expect(session?.status).toBe('done');

    store.close();
  });

  it('refresh reject khi resume phiên -> coi như unknown, phiên tiếp tục và luôn setSessionStatus trong finally', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);

    const goal = store.createGoal(repo, 'Build feature');
    const sId = store.createSession([1] as any, repo);
    store.setSessionStatus(sId, 'awaiting_approval');

    store.upsertTicket(repo, {
      id: 'GTM-0001',
      goal: 'G1',
      number: 1,
      of: 1,
      title: 'Build feature',
      type: 'feat',
      size: 'S',
      scope: ['src/app.ts'],
      acceptance: ['Works'],
      done_when: 'Done',
      depends_on: [],
      from_audit: false,
    });
    writeTicketFile(repo, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
    git(repo, 'checkout', '-b', goal.branch);
    commitAll(repo, 'pm: tickets', { name: 'elon', email: 'elon@btm.local' });

    const { runner } = createFakeRunner([
      (_seat, agent, _prompt, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);

    const refresh = vi.fn().mockRejectedValue(new Error('Quota CLI network timeout'));

    deps.runner = runner;
    deps.refresh = refresh;
    deps.gate = () => ({ ok: true as const });

    const outcome = await resumeSession(deps, sId);

    expect(outcome.notes).toEqual([]);
    expect(outcome.status).toBe('done');
    const session = store.getSession(sId);
    expect(session?.status).toBe('done');

    store.close();
  });

  it('test tích hợp session + monitor thật: Energy 50% ở lượt Dev, tụt 10% trước lượt QC -> QC không chạy, needs_owner có "hồi lúc"', async () => {
    const repo = tmpRepo({ 'src/app.ts': 'export const app = 1;\n' });
    const { deps, store, cfg } = makeDeps(repo);

    let devRan = false;
    let qcRan = false;
    let jennyEnergy = 50;

    let nowTime = new Date('2026-11-08T15:00:00.000Z');
    const now = () => nowTime;

    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_s, agent, _p, cwd) => {
        devRan = true;
        nowTime = new Date(nowTime.getTime() + 200_000);
        jennyEnergy = 10;
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 100;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => {
        qcRan = true;
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
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
      detail: 'Ok',
    }));

    const monitor = createMonitor({
      cfg,
      store,
      readEnergy: mockReadEnergy as any,
      checkLogin: mockCheckLogin as any,
      now,
    });

    deps.runner = runner;
    deps.monitor = monitor;

    const outcome = await runSession(deps, ['Implement feature'], { approved: true });

    expect(devRan).toBe(true);
    expect(qcRan).toBe(false);
    expect(outcome.status).toBe('needs_owner');
    expect(outcome.notes.some((note) => note.includes('resets'))).toBe(true);
    expect(outcome.notes.some((note) => note.includes('10%') && note.includes('19:57'))).toBe(true);

    const failures = store.listHandoffFailures(outcome.sessionId!);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].reason).toContain('resets');

    store.close();
  });

  describe('resumeSession', () => {
    it('chỉ cho session awaiting_approval, needs_owner, stopped: throw khi session khác hoặc không tồn tại', async () => {
      const repo = tmpRepo({});
      const { deps, store } = makeDeps(repo);

      await expect(resumeSession(deps, 999)).rejects.toThrow();

      const sId = store.createSession([1] as any, repo);
      store.setSessionStatus(sId, 'done');
      await expect(resumeSession(deps, sId)).rejects.toThrow();

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

      const sId = store.createSession([1] as any, repoA);
      store.setSessionStatus(sId, 'awaiting_approval');

      await expect(resumeSession(depsB, sId)).rejects.toThrow(/belongs to project/i);
      expect(store.getSession(sId)?.status).toBe('awaiting_approval');

      store.close();
    });

    it('resumeSession resumes needs_owner and stopped sessions without calling PM, preserving fix_rounds and non-pending states', async () => {
      const repo = tmpRepo({ 'src/app.ts': '1' });
      const { deps, store } = makeDeps(repo);

      const goal = store.createGoal(repo, 'Resume test');
      const sId = store.createSession([1] as any, repo);
      store.setSessionStatus(sId, 'stopped');

      store.upsertTicket(repo, {
        id: 'GTM-0001',
        goal: 'G1',
        number: 1,
        of: 2,
        title: 'Task 1',
        type: 'feat',
        size: 'S',
        scope: ['src/app.ts'],
        acceptance: ['ok'],
        done_when: 'ok',
        depends_on: [],
        from_audit: false,
      });
      store.upsertTicket(repo, {
        id: 'GTM-0002',
        goal: 'G1',
        number: 2,
        of: 2,
        title: 'Task 2',
        type: 'feat',
        size: 'S',
        scope: ['src/app.ts'],
        acceptance: ['ok'],
        done_when: 'ok',
        depends_on: [],
        from_audit: false,
      });
      store.setTicketState(repo, 'GTM-0001', 'passed', 'core', 'already passed', 2);
      store.setTicketState(repo, 'GTM-0002', 'returned', 'core', 'fix needed', 1);

      writeTicketFile(repo, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2, title: 'Task 1' });
      writeTicketFile(repo, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2, title: 'Task 2' });

      git(repo, 'checkout', '-b', goal.branch);
      commitAll(repo, 'PM tickets', { name: 'elon', email: 'elon@btm.local' });

      let pmCalled = false;
      let devCalledForT001 = false;
      let devCalledForT002 = false;

      const { runner } = createFakeRunner([
        (seat, agent, prompt, cwd) => {
          if (seat === 'pm') pmCalled = true;
          if (seat === 'dev') {
            if (prompt.includes('GTM-0001')) devCalledForT001 = true;
            if (prompt.includes('GTM-0002')) devCalledForT002 = true;
            writeFileSync(join(cwd, 'src', 'app.ts'), 'dev done');
            writeDevReport(cwd, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2 }, agent);
          }
        },
        () => makeQcResponse({ id: 'GTM-0002', goal: 'G1', number: 2 }, 'pass'),
      ]);
      deps.runner = runner;

      const outcome = await resumeSession(deps, sId);
      expect(outcome.status).toBe('done');
      expect(pmCalled).toBe(false);
      expect(devCalledForT001).toBe(false);
      expect(devCalledForT002).toBe(true);
      expect(outcome.tasks['GTM-0001']).toBe('passed');
      expect(outcome.tasks['GTM-0002']).toBe('passed');

      store.close();
    });

    it('dừng sau gate, resume → QC prompt chứa base_sha cũ và diff không rỗng', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'console.log("v1");\n' });
      const { deps, store } = makeDeps(repo);

      let qcPromptCaptured = '';
      let initialBaseSha = '';
      let devRan = false;
      let stoppedAfterGate = false;

      deps.gate = (_agent: string) => {
        if (devRan && !stoppedAfterGate) {
          return { ok: false, reason: 'gate_stop_after_dev_gate' };
        }
        return { ok: true };
      };

      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          initialBaseSha = headSha(cwd);
          writeFileSync(join(cwd, 'src', 'app.ts'), 'console.log("v2");\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
          devRan = true;
        },
      ]);
      deps.runner = runner;

      const firstOutcome = await runSession(deps, ['Test base_sha resume'], { approved: true });
      expect(firstOutcome.status).toBe('needs_owner');
      expect(firstOutcome.notes).toContain('gate_stop_after_dev_gate');

      const ticketState = store.getTicketState(repo, 'GTM-0001');
      expect(ticketState?.state).toBe('awaiting_qc');
      expect(ticketState?.base_sha).toBe(initialBaseSha);

      stoppedAfterGate = true;
      deps.gate = () => ({ ok: true });

      const { runner: resumeRunner } = createFakeRunner([
        (_s, _a, prompt) => {
          qcPromptCaptured = prompt;
          return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
        },
      ]);
      deps.runner = resumeRunner;

      const resumeOutcome = await resumeSession(deps, firstOutcome.sessionId!);
      expect(resumeOutcome.status).toBe('done');

      expect(qcPromptCaptured).toContain(`base commit ${initialBaseSha}`);

      const diffOutput = git(repo, 'diff', `${initialBaseSha}..HEAD`, '--', 'src/app.ts');
      expect(diffOutput.trim()).not.toBe('');
      expect(diffOutput).toContain('+console.log("v2");');

      store.close();
    });

    it('kết thúc phiên: nếu còn ticket failed/blocked (kể cả có từ trước khi resume) → needs_owner kèm danh sách ticket, không "done"', async () => {
      const repo = tmpRepo({ 'src/app.ts': '1' });
      const { deps, store } = makeDeps(repo);

      const goal = store.createGoal(repo, 'Residual failed/blocked test');
      const sId = store.createSession([1] as any, repo);
      store.setSessionStatus(sId, 'needs_owner');

      store.upsertTicket(repo, {
        id: 'GTM-0001',
        goal: 'G1',
        number: 1,
        of: 2,
        title: 'Task 1',
        type: 'feat',
        size: 'S',
        scope: ['src/app.ts'],
        acceptance: ['ok'],
        done_when: 'ok',
        depends_on: ['GTM-0000'],
        from_audit: false,
      });
      store.upsertTicket(repo, {
        id: 'GTM-0002',
        goal: 'G1',
        number: 2,
        of: 2,
        title: 'Task 2',
        type: 'feat',
        size: 'S',
        scope: ['src/app.ts'],
        acceptance: ['ok'],
        done_when: 'ok',
        depends_on: [],
        from_audit: false,
      });

      writeTicketFile(repo, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2, title: 'Task 1', depends_on: ['GTM-0000'] });
      writeTicketFile(repo, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2, title: 'Task 2' });

      git(repo, 'checkout', '-b', goal.branch);
      commitAll(repo, 'PM cards', { name: 'elon', email: 'elon@btm.local' });

      deps.runner = async () => ({ exitCode: 0, timedOut: false, durationMs: 0, output: '', lastMessage: '' });

      const outcome = await resumeSession(deps, sId);
      expect(outcome.status).toBe('needs_owner');
      expect(outcome.tasks['GTM-0001']).toBe('blocked');
      expect(outcome.notes.some((n) => n.includes('GTM-0001'))).toBe(true);

      store.close();
    });
  });

  describe('Task 7: Audit Seat (Kai) & PM Tightening', () => {
    function getAuditDeps(repo: string, auditAgent = 'kai') {
      const base = loadConfig('btm.config.yaml');
      return makeDeps(repo, {
        seats: {
          ...base.seats,
          audit: auditAgent,
        },
        agents: {
          ...base.agents,
          kai: {
            tool: 'antigravity-cli',
            command: 'agy',
            can_sit: ['audit'],
          },
        },
      });
    }

    it('audit pass → goal audit_passed, report G1-audit.md committed', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = getAuditDeps(repo, 'kai');

      const { runner, calls } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'pass',
            findings: [],
          }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Security Goal'], { approved: true });

      expect(outcome.status).toBe('done');
      expect(calls.length).toBe(4);
      expect(calls[0].seat).toBe('pm');
      expect(calls[1].seat).toBe('dev');
      expect(calls[2].seat).toBe('qc');
      expect(calls[3].seat).toBe('audit');
      expect(calls[3].agentId).toBe('kai');

      const goal = store.getGoal(repo, 1);
      expect(goal?.state).toBe('audit_passed');

      const auditReportPath = join(repo, 'team', 'reports', 'G1-audit.md');
      expect(existsSync(auditReportPath)).toBe(true);
      const auditContent = readFileSync(auditReportPath, 'utf8');
      expect(auditContent).toContain('Verdict: pass');

      const log = git(repo, 'log', '--oneline', '-n', '3');
      expect(log).toContain('G1: audit pass');
      expect(log).toContain('G1: summary');

      store.close();
    });

    it('auditor_is_coder: auditor coded a ticket in the goal → needs_owner, lý do auditor_is_coder', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      // Jacky is coder and also set as auditor
      const base = loadConfig('btm.config.yaml');
      const { deps, store } = makeDeps(repo, {
        seats: {
          ...base.seats,
          audit: 'jacky',
        },
        agents: {
          ...base.agents,
          jacky: {
            tool: 'antigravity-cli',
            command: 'agy',
            can_sit: ['dev', 'audit'],
          },
        },
      });

      let auditCalled = false;
      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        () => {
          auditCalled = true;
          return { lastMessage: JSON.stringify({ verdict: 'pass', findings: [] }) };
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Auditor conflict test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes.some((n) => n.includes('auditor_is_coder'))).toBe(true);
      expect(auditCalled).toBe(false);

      store.close();
    });

    it('audit_modified_repo: working tree dirty after audit → needs_owner, note audit_modified_repo, không gọi PM', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = getAuditDeps(repo, 'kai');

      const { runner, calls } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        (_s, _a, _p, cwd) => {
          // Audit agent wrongfully writes a file!
          writeFileSync(join(cwd, 'bad_audit_leak.txt'), 'illegal write');
          return {
            lastMessage: JSON.stringify({
              verdict: 'pass',
              findings: [],
            }),
          };
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Security Goal Dirty Audit'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('audit_modified_repo');
      expect(calls.length).toBe(4);
      expect(calls.some((c) => c.seat === 'pm' && calls.indexOf(c) > 3)).toBe(false);

      // The dirty file was cleaned
      expect(existsSync(join(repo, 'bad_audit_leak.txt'))).toBe(false);

      // Report G1-audit.md exists
      const reportPath = join(repo, 'team', 'reports', 'G1-audit.md');
      expect(existsSync(reportPath)).toBe(true);
      const content = readFileSync(reportPath, 'utf8');
      expect(content).toContain('audit_modified_repo');

      store.close();
    });

    it('audit fail high → PM nhận findings, tạo ticket mới from_audit: true, chạy Dev+QC và audit lại pass', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = getAuditDeps(repo, 'kai');

      let pmFixPromptReceived = '';
      const { runner, calls } = createFakeRunner([
        // 1. PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // 2. Dev 1
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // 3. QC 1
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        // 4. Audit 1: fail with high finding
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'fail',
            findings: [
              { ticket: 'GTM-0001', severity: 'high', text: 'Hardcoded secret token in app.ts' },
            ],
          }),
        }),
        // 5. PM 2: fix ticket
        (_s, _a, prompt, cwd) => {
          pmFixPromptReceived = prompt;
          writeTicketFile(cwd, {
            id: 'GTM-0002',
            goal: 'G1',
            number: 2,
            of: 2,
            from_audit: true,
          });
        },
        // 6. Dev 2
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 2;\n');
          writeDevReport(cwd, { id: 'GTM-0002', goal: 'G1', number: 2, of: 2 }, agent);
        },
        // 7. QC 2
        () => makeQcResponse({ id: 'GTM-0002', goal: 'G1', number: 2 }, 'pass'),
        // 8. Audit 2: pass
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'pass',
            findings: [],
          }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Security Goal'], { approved: true });

      expect(outcome.status).toBe('done');
      expect(calls.length).toBe(8);
      expect(pmFixPromptReceived).toContain('from_audit: true');
      expect(pmFixPromptReceived).toContain('Hardcoded secret token in app.ts');

      const t2State = store.getTicketState(repo, 'GTM-0002');
      expect(t2State?.state).toBe('passed');

      const goal = store.getGoal(repo, 1);
      expect(goal?.state).toBe('audit_passed');

      store.close();
    });

    it('FIX-E B8: PM sau audit tạo ticket mới cho goal khác → pm_ticket_wrong_goal và dọn sạch', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = getAuditDeps(repo, 'kai');
      const { runner, calls } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'fail',
            findings: [{ ticket: 'GTM-0001', severity: 'high', text: 'needs follow-up' }],
          }),
        }),
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, {
            id: 'GTM-0002',
            goal: 'G2',
            number: 1,
            of: 1,
            from_audit: true,
          });
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Security Goal'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('pm_ticket_wrong_goal');
      expect(calls).toHaveLength(5);
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0002.md'))).toBe(false);
      expect(store.getTicketState(repo, 'GTM-0002')).toBeNull();
      expect(store.nextTicketSeq(repo)).toBe(2);

      store.close();
    });

    it('output audit rác → audit_output_invalid, needs_owner, không gọi PM', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = getAuditDeps(repo, 'kai');

      const { runner, calls } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        () => ({
          lastMessage: 'Totally corrupt output not json at all',
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Corrupt Audit Test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('audit_output_invalid');
      expect(calls.length).toBe(4);
      expect(calls.some((c) => c.seat === 'pm' && calls.indexOf(c) > 3)).toBe(false);

      const reportPath = join(repo, 'team', 'reports', 'G1-audit.md');
      expect(existsSync(reportPath)).toBe(true);
      const content = readFileSync(reportPath, 'utf8');
      expect(content).toContain('audit_output_invalid');

      store.close();
    });

    it('audit fail rỗng findings → audit_fail_no_findings, needs_owner, không gọi PM', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = getAuditDeps(repo, 'kai');

      const { runner, calls } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'fail',
            findings: [],
          }),
        }),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Empty Findings Fail Test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('audit_fail_no_findings');
      expect(calls.length).toBe(4);
      expect(calls.some((c) => c.seat === 'pm' && calls.indexOf(c) > 3)).toBe(false);

      const reportPath = join(repo, 'team', 'reports', 'G1-audit.md');
      expect(existsSync(reportPath)).toBe(true);
      const content = readFileSync(reportPath, 'utf8');
      expect(content).toContain('Verdict: fail');

      store.close();
    });

    it('pm_modified_existing_ticket: PM modifies existing ticket file during initial turn → needs_owner, reverts file', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      // Pre-create an existing ticket in repo (e.g. from an earlier goal G0)
      writeTicketFile(repo, { id: 'GTM-0000', goal: 'G0', number: 1, of: 1, title: 'Original Title' });
      commitAll(repo, 'Init GTM-0000', { name: 'core', email: 'core@btm.local' });

      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          // PM modifies existing GTM-0000.md!
          writeTicketFile(cwd, { id: 'GTM-0000', goal: 'G0', number: 1, of: 1, title: 'Hacked Title' });
          // PM also creates valid GTM-0001.md
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal 1'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('pm_modified_existing_ticket');

      // Check that existing file GTM-0000.md was restored!
      const content = readFileSync(join(repo, 'team', 'tickets', 'GTM-0000.md'), 'utf8');
      expect(content).toContain('Original Title');
      expect(content).not.toContain('Hacked Title');

      // Check that new file GTM-0001.md was removed!
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0001.md'))).toBe(false);

      store.close();
    });

    it('pm_modified_existing_ticket: PM deletes existing ticket file during initial turn → needs_owner, restores file', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      writeTicketFile(repo, { id: 'GTM-0000', goal: 'G0', number: 1, of: 1, title: 'To Be Kept' });
      commitAll(repo, 'Init GTM-0000', { name: 'core', email: 'core@btm.local' });

      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          // PM deletes GTM-0000.md!
          rmSync(join(cwd, 'team', 'tickets', 'GTM-0000.md'));
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal 1'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('pm_modified_existing_ticket');

      // Check that GTM-0000.md was restored!
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0000.md'))).toBe(true);

      store.close();
    });

    it('pm_modified_existing_ticket: PM modifies existing ticket during audit fix turn → needs_owner, reverts file', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = getAuditDeps(repo, 'kai');

      const { runner, calls } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, title: 'Original GTM-0001' });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
        () => ({
          lastMessage: JSON.stringify({
            verdict: 'fail',
            findings: [{ ticket: 'GTM-0001', severity: 'high', text: 'Security bug' }],
          }),
        }),
        // PM fix turn: instead of creating GTM-0002, modifies GTM-0001!
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, title: 'Illegally Modified' });
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Audit fix tightening test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('pm_modified_existing_ticket');

      // Verify that GTM-0001 was restored to its committed content
      const content = readFileSync(join(repo, 'team', 'tickets', 'GTM-0001.md'), 'utf8');
      expect(content).toContain('Original GTM-0001');
      expect(content).not.toContain('Illegally Modified');

      store.close();
    });
  });

  describe('P4-FIX-A: git turn safety', () => {
    it('FIX-E B6: snapshot được lưu trước runner và xoá sau khi guard hoàn tất', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          const snapshot = JSON.parse(store.getSetting(`turn_guard:${repo}`) || 'null');
          expect(snapshot?.seat).toBe('pm');
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
          return { exitCode: 1 };
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Persist guard snapshot'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(store.getSetting(`turn_guard:${repo}`)).toBe('');
      store.close();
    });

    it('FIX-E B6: runSession và resumeSession khôi phục snapshot tồn đọng rồi trả recovered_interrupted_turn', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const goal = store.createGoal(repo, 'Interrupted goal');
      const mainBefore = git(repo, 'rev-parse', 'refs/heads/main').trim();
      git(repo, 'checkout', '-b', goal.branch);
      writeFileSync(join(repo, 'partial.ts'), 'partial');
      commitAll(repo, 'partial interrupted turn', { name: 'dev', email: 'dev@btm.local' });
      const goalHead = headSha(repo);
      deps.runner = vi.fn();

      snapshotTurn(repo, goal.branch, 'main', store, 'dev');
      git(repo, 'update-ref', 'refs/heads/main', goalHead);
      const runOutcome = await runSession(deps, [{ n: goal.n }], { approved: true });

      expect(runOutcome).toMatchObject({
        status: 'needs_owner',
        sessionId: null,
        notes: ['recovered_interrupted_turn'],
      });
      // D4: main đổi lúc phục hồi → không tự kéo về (có thể là anh merge tay); sha ghim giữ nguyên nên phiên sau vẫn bị chặn
      expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(goalHead);
      expect(store.getSetting(`protected_sha:${repo}`)).toBe(mainBefore);
      expect(store.getSetting(`turn_guard:${repo}`)).toBe('');
      expect(store.getGoal(repo, goal.n)?.state).toBe('open');
      git(repo, 'update-ref', 'refs/heads/main', mainBefore); // anh đưa main về

      const sessionId = store.createSession([String(goal.n)], repo);
      store.setSessionStatus(sessionId, 'needs_owner');
      snapshotTurn(repo, goal.branch, 'main', store, 'dev');
      git(repo, 'update-ref', 'refs/heads/main', goalHead);
      const resumeOutcome = await resumeSession(deps, sessionId);

      expect(resumeOutcome).toMatchObject({
        status: 'needs_owner',
        sessionId,
        notes: ['recovered_interrupted_turn'],
      });
      expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(goalHead);
      expect(store.getSetting(`protected_sha:${repo}`)).toBe(mainBefore);
      expect(store.getSetting(`turn_guard:${repo}`)).toBe('');
      expect(store.getSession(sessionId)?.status).toBe('needs_owner');
      expect(deps.runner).not.toHaveBeenCalled();

      store.close();
    });

    it('QC checkout main + sửa file + git commit → sau session rev-parse main == trước, HEAD = nhánh goal, verdict fail có lỗi agent_modified_protected_branch', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const mainShaBefore = git(repo, 'rev-parse', 'main').trim();

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // QC switches to main, modifies file, commits
        (_s, _a, _p, cwd) => {
          git(cwd, 'checkout', 'main');
          writeFileSync(join(cwd, 'src', 'hacked.ts'), 'export const hack = 1;\n');
          git(cwd, 'add', '.');
          git(cwd, '-c', 'user.name=qc', '-c', 'user.email=qc@btm.local', 'commit', '-m', 'qc hack on main');
          return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['QC switch branch test'], { approved: true });

      // main KHÔNG đổi (so sha)
      expect(git(repo, 'rev-parse', 'main').trim()).toBe(mainShaBefore);

      // Quay về nhánh goal
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('goal/G1-qc-switch-branch-test');

      // QC verdict fail
      const qcReportPath = join(repo, 'team', 'reports', 'GTM-0001-qc.json');
      expect(existsSync(qcReportPath)).toBe(true);
      const qcData = JSON.parse(readFileSync(qcReportPath, 'utf8'));
      expect(qcData.verdict).toBe('fail');
      expect(qcData.bugs).toContain('agent_modified_protected_branch');

      store.close();
    });

    it('Dev checkout main + sửa file + git commit → main không đổi, needs_owner kèm agent_modified_protected_branch', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const mainShaBefore = git(repo, 'rev-parse', 'main').trim();

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev switches to main, modifies file, commits
        (_s, agent, _p, cwd) => {
          git(cwd, 'checkout', 'main');
          writeFileSync(join(cwd, 'src', 'hacked.ts'), 'export const hack = 1;\n');
          git(cwd, 'add', '.');
          git(cwd, '-c', 'user.name=dev', '-c', 'user.email=dev@btm.local', 'commit', '-m', 'dev hack on main');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Dev switch branch test'], { approved: true });

      // main không đổi
      expect(git(repo, 'rev-parse', 'main').trim()).toBe(mainShaBefore);

      // outcome needs_owner kèm agent_modified_protected_branch
      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('agent_modified_protected_branch');

      // Quay về nhánh goal
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('goal/G1-dev-switch-branch-test');

      store.close();
    });

    it('PM checkout main + sửa file + git commit → main không đổi, needs_owner kèm agent_modified_protected_branch', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const mainShaBefore = git(repo, 'rev-parse', 'main').trim();

      const { runner } = createFakeRunner([
        // PM switches to main, modifies file, commits
        (_s, _a, _p, cwd) => {
          git(cwd, 'checkout', 'main');
          writeFileSync(join(cwd, 'src', 'hacked.ts'), 'export const hack = 1;\n');
          git(cwd, 'add', '.');
          git(cwd, '-c', 'user.name=pm', '-c', 'user.email=pm@btm.local', 'commit', '-m', 'pm hack on main');
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['PM switch branch test'], { approved: true });

      // main không đổi
      expect(git(repo, 'rev-parse', 'main').trim()).toBe(mainShaBefore);

      // outcome needs_owner kèm agent_modified_protected_branch
      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('agent_modified_protected_branch');

      // Quay về nhánh goal
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('goal/G1-pm-switch-branch-test');

      store.close();
    });

    it('QC tạo nhánh mới → phát hiện', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // QC creates new branch
        (_s, _a, _p, cwd) => {
          git(cwd, 'checkout', '-b', 'qc-rogue-branch');
          return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['QC new branch test'], { approved: true });

      // Nhánh rogue không bị xoá
      expect(git(repo, 'rev-parse', '--verify', 'qc-rogue-branch').trim()).toBeTruthy();

      // Core quay về nhánh goal
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('goal/G1-qc-new-branch-test');

      // QC verdict fail
      const qcReportPath = join(repo, 'team', 'reports', 'GTM-0001-qc.json');
      expect(existsSync(qcReportPath)).toBe(true);
      const qcData = JSON.parse(readFileSync(qcReportPath, 'utf8'));
      expect(qcData.verdict).toBe('fail');
      expect(qcData.bugs).toContain('agent_switched_branch');

      store.close();
    });

    it('Dev checkout main + sửa file → main không đổi', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const mainShaBefore = git(repo, 'rev-parse', 'main').trim();

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev switches to main and modifies file
        (_s, agent, _p, cwd) => {
          git(cwd, 'checkout', 'main');
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 999;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Dev switch branch test'], { approved: true });

      // main KHÔNG đổi (so sha)
      expect(git(repo, 'rev-parse', 'main').trim()).toBe(mainShaBefore);

      // Quay về nhánh goal
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('goal/G1-dev-switch-branch-test');

      // Nội dung trên main không đổi
      git(repo, 'checkout', 'main');
      expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const a = 0;\n');

      store.close();
    });

    it('Dev sửa nhánh goal khác → khôi phục nhánh goal khác, outcome needs_owner kèm agent_modified_other_goal', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      // Tạo nhánh goal khác trước session: goal/G2-other
      git(repo, 'checkout', '-b', 'goal/G2-other');
      writeFileSync(join(repo, 'src', 'g2.ts'), 'export const g2 = 1;\n');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.name=core', '-c', 'user.email=core@btm.local', 'commit', '-m', 'G2 init');
      const g2ShaBefore = git(repo, 'rev-parse', 'refs/heads/goal/G2-other').trim();

      git(repo, 'checkout', 'main');

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev switches to goal/G2-other and tampers with it
        (_s, agent, _p, cwd) => {
          git(cwd, 'checkout', 'goal/G2-other');
          writeFileSync(join(cwd, 'src', 'g2.ts'), 'export const g2 = 999; // tampered\n');
          git(cwd, 'add', '.');
          git(cwd, '-c', 'user.name=dev', '-c', 'user.email=dev@btm.local', 'commit', '-m', 'tamper g2');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Dev tamper other goal test'], { approved: true });

      // goal/G2-other được phục hồi
      expect(git(repo, 'rev-parse', 'refs/heads/goal/G2-other').trim()).toBe(g2ShaBefore);

      // outcome báo needs_owner kèm agent_modified_other_goal
      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('agent_modified_other_goal');

      store.close();
    });

    it('PM tự commit file ngoài team/tickets → pm_out_of_scope', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      const { runner } = createFakeRunner([
        // PM creates ticket and commits an illegal file outside team/tickets
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
          writeFileSync(join(cwd, 'src', 'hacked.ts'), 'export const hack = 1;\n');
          git(cwd, 'add', '.');
          git(cwd, '-c', 'user.name=pm', '-c', 'user.email=pm@btm.local', 'commit', '-m', 'PM illegal commit');
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['PM out of scope commit'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('pm_out_of_scope');

      // File hacked.ts không còn tồn tại trên working tree
      expect(existsSync(join(repo, 'src', 'hacked.ts'))).toBe(false);

      store.close();
    });

    it('QC timeout có sửa file → không có commit WIP chứa sửa đổi QC', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // QC modifies file and times out
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'corrupted by QC');
          return { timedOut: true };
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['QC timeout test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('timeout');

      // Không có commit WIP chứa sửa đổi QC
      const commits = git(repo, 'log', '--oneline', 'main..HEAD').trim().split('\n');
      expect(commits.some((c) => c.includes('WIP') && c.includes('timeout'))).toBe(false);

      // File src/app.ts vẫn giữ nguyên code của Dev, không bị sửa đổi bởi QC
      expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const a = 1;\n');

      store.close();
    });

    it('Dev abort → có commit <ID>: WIP aborted, resume lần sau gate KHÔNG báo commit_missing_ticket_id', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const abortCtl = new AbortController();

      const runner1 = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev starts work and gets aborted
        (_s, _a, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1; // partial');
          abortCtl.abort();
        },
      ]);
      deps.runner = runner1.runner;
      deps.signal = abortCtl.signal;

      const outcome1 = await runSession(deps, ['Dev abort test'], { approved: true });
      expect(outcome1.status).toBe('stopped');

      // Có commit GTM-0001: WIP aborted
      const commits1 = git(repo, 'log', '--oneline', 'main..HEAD').trim().split('\n');
      expect(commits1.some((c) => c.includes('GTM-0001: WIP aborted'))).toBe(true);

      // Working tree sạch
      expect(git(repo, 'status', '--porcelain').trim()).toBe('');

      // Resume session lần 2
      const deps2 = { ...deps, signal: undefined };
      const runner2 = createFakeRunner([
        // Dev resumes and completes
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // QC passes
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
      ]);
      deps2.runner = runner2.runner;

      const outcome2 = await resumeSession(deps2, outcome1.sessionId!);
      expect(outcome2.status).toBe('done');
      expect(outcome2.tasks['GTM-0001']).toBe('passed');

      store.close();
    });

    it('tree bẩn đầu phiên → needs_owner, không commit', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const mainShaBefore = git(repo, 'rev-parse', 'main').trim();

      // Tạo file chưa commit làm bẩn working tree
      writeFileSync(join(repo, 'uncommitted.txt'), 'dirty content');

      const outcome = await runSession(deps, ['Dirty tree at start test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes.some((n) => n.includes('dirty_tree_at_start'))).toBe(true);
      expect(outcome.notes.some((n) => n.includes('main'))).toBe(true);

      // Không commit gì lên main (mainSha không đổi, không có checkpoint commit)
      expect(git(repo, 'rev-parse', 'main').trim()).toBe(mainShaBefore);
      const logMain = git(repo, 'log', '-n', '1', '--oneline');
      expect(logMain).not.toContain('checkpoint');

      store.close();
    });

    it('PM lỗi (exit_1) → khôi phục team/tickets/, không để file ticket rác, không upsert/setTicketState', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      const { runner } = createFakeRunner([
        // PM writes a ticket file, but exits with error 1
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
          return { exitCode: 1, output: 'PM syntax failure' };
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['PM error test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('exit_1');

      // File ticket không còn tồn tại trên disk
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0001.md'))).toBe(false);

      // Không có commit ticket nào
      const log = git(repo, 'log', '--oneline');
      expect(log).not.toContain('GTM-0001');

      // DB không có ticket GTM-0001
      expect(store.getTicketState(repo, 'GTM-0001')).toBeNull();

      store.close();
    });

    it('PM tạo ticket nhảy số (GTM-0001, GTM-0003) → pm_ticket_id_not_sequential, dọn dẹp tickets, counter không tăng', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      const { runner } = createFakeRunner([
        // PM creates GTM-0001 and GTM-0003 (skipping GTM-0002)
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 2 });
          writeTicketFile(cwd, { id: 'GTM-0003', goal: 'G1', number: 2, of: 2 });
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['PM non-sequential test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('pm_ticket_id_not_sequential');

      // File tickets đã bị dọn dẹp
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0001.md'))).toBe(false);
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0003.md'))).toBe(false);

      // Counter không bị bump lên 3 hay 4, vẫn là 1
      expect(store.nextTicketSeq(repo)).toBe(1);
      expect(store.getTicketState(repo, 'GTM-0001')).toBeNull();

      store.close();
    });

    it('FIX-E B8: PM tạo file ticket mới cho goal khác → pm_ticket_wrong_goal và dọn sạch', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G2', number: 1, of: 1 });
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Goal 1'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('pm_ticket_wrong_goal');
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0001.md'))).toBe(false);
      expect(store.getTicketState(repo, 'GTM-0001')).toBeNull();
      expect(store.nextTicketSeq(repo)).toBe(1);

      store.close();
    });

    it('Coder từ lịch sử phiên trước → không được QC ticket đó (coder_cannot_qc_same_task)', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo, {
        seats: { pm: 'claudine', dev: 'jacky', qc: 'jenny', audit: 'alex' },
        rules: { coder_cannot_qc_same_task: true } as any,
      });

      // Tạo ticket GTM-0001 đã có lịch sử do jenny chuyển sang in_dev ở phiên trước
      store.upsertTicket(repo, {
        id: 'GTM-0001',
        goal: 'G1',
        number: 1,
        of: 1,
        title: 'Task 1',
        type: 'feat',
        size: 'S',
        scope: ['src/a.ts'],
        acceptance: ['ok'],
        done_when: 'ok',
        depends_on: [],
        from_audit: false,
      });
      // Ghi nhận lịch sử: jenny đã từng chuyển sang in_dev (code ticket này)
      store.setTicketState(repo, 'GTM-0001', 'in_dev', 'jenny', 'started coding in past session');
      store.setTicketState(repo, 'GTM-0001', 'awaiting_qc', 'jenny', 'ready for qc');

      // Tạo goal G1 và file ticket
      store.createGoal(repo, 'Goal 1');
      writeTicketFile(repo, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      commitAll(repo, 'setup ticket', { name: 'core', email: 'core@btm.local' });

      // Phiên này QC là jenny. Phiên started với ticket awaiting_qc
      const outcome = await runSession(deps, [{ n: 1 }], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('coder_cannot_qc_same_task');

      store.close();
    });

    it('Coder từ lịch sử bất kỳ ticket nào của goal → không được Audit goal đó (auditor_is_coder)', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo, {
        seats: { pm: 'claudine', dev: 'jacky', qc: 'jenny', audit: 'alex' },
      });

      // alex đã từng chuyển GTM-0001 sang in_dev trong lịch sử
      store.upsertTicket(repo, {
        id: 'GTM-0001',
        goal: 'G1',
        number: 1,
        of: 1,
        title: 'Task 1',
        type: 'feat',
        size: 'S',
        scope: ['src/a.ts'],
        acceptance: ['ok'],
        done_when: 'ok',
        depends_on: [],
        from_audit: false,
      });
      store.setTicketState(repo, 'GTM-0001', 'in_dev', 'alex', 'alex coded in past session');
      store.setTicketState(repo, 'GTM-0001', 'passed', 'jenny', 'qc passed');

      // Tạo goal G1 và file ticket
      store.createGoal(repo, 'Goal 1');
      writeTicketFile(repo, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      commitAll(repo, 'setup passed ticket', { name: 'core', email: 'core@btm.local' });

      // Phiên này alex làm auditor. Tất cả ticket đã pass, bước vào audit
      const outcome = await runSession(deps, [{ n: 1 }], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('auditor_is_coder');

      store.close();
    });

    it('Dev sửa file ticket → gate rớt ticket_tampered, Core khôi phục ticket từ base và commit <ID>: restore tickets', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      let devRound = 0;
      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, title: 'Original title' });
        },
        // Dev round 1: modifies team/tickets/GTM-0001.md
        (_s, agent, _p, cwd) => {
          devRound++;
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1, title: 'Hacked title' });
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // Dev round 2 (after gate fails ticket_tampered and restores): completes cleanly
        (_s, agent, _p, cwd) => {
          devRound++;
          // Kiểm tra file ticket đã được khôi phục về Original title
          const ticketContent = readFileSync(join(cwd, 'team', 'tickets', 'GTM-0001.md'), 'utf8');
          expect(ticketContent).toContain('Original title');
          expect(ticketContent).not.toContain('Hacked title');
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 2;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // QC passes
        () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Dev tamper ticket test'], { approved: true });

      expect(outcome.status).toBe('done');
      expect(devRound).toBe(2);

      // Có commit restore tickets
      const commits = git(repo, 'log', '--oneline');
      expect(commits).toContain('GTM-0001: restore tickets');

      store.close();
    });

    it('Lệnh gate làm bẩn tree → Core tự clean trước khi gọi QC, QC không bị qc_modified_repo', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      // Cấu hình gate test command tạo ra file rác không bị gitignore
      const { deps, store } = makeDeps(repo);
      deps.cfg.gate.commands.test = 'echo dirty > gate-dirty.txt';

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        // QC runs and does not touch files
        (_s, _a, _p, cwd) => {
          // File gate-dirty.txt đã được dọn sạch trước khi QC chạy
          expect(existsSync(join(cwd, 'gate-dirty.txt'))).toBe(false);
          return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Gate dirty tree test'], { approved: true });

      // QC pass, không bị fail bởi qc_modified_repo
      expect(outcome.status).toBe('done');
      const qcReportPath = join(repo, 'team', 'reports', 'GTM-0001-qc.json');
      expect(existsSync(qcReportPath)).toBe(true);
      const qcData = JSON.parse(readFileSync(qcReportPath, 'utf8'));
      expect(qcData.verdict).toBe('pass');

      store.close();
    });

    it('FIX-F C1: lượt agent thêm gpg.program/clean filter vào .git/config và .git/info/attributes → sau guard config như cũ, script KHÔNG chạy khi BTM commit, có vi phạm git_config_tampered', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const configPath = join(repo, '.git', 'config');
      const attrPath = join(repo, '.git', 'info', 'attributes');
      const originalConfig = readFileSync(configPath, 'utf8');
      const markerFile = join(repo, 'evil-ran.txt');
      const evilScript = join(repo, 'evil-gpg.js');

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev cài gpg.program + clean filter độc
        (_s, agent, _p, cwd) => {
          writeFileSync(
            evilScript,
            `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(markerFile.replace(/\\/g, '/'))}, 'ran'); process.stdout.write(fs.readFileSync(0, 'utf8'));\n`,
            'utf8'
          );
          const cmd = `node "${evilScript.replace(/\\/g, '/')}"`;
          writeFileSync(
            configPath,
            `${originalConfig}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${cmd}\n[filter "x"]\n\tclean = ${cmd}\n`,
            'utf8'
          );
          mkdirSync(join(cwd, '.git', 'info'), { recursive: true });
          writeFileSync(attrPath, '* filter=x\n', 'utf8');
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Git config tamper test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('git_config_tampered');
      expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);
      expect(existsSync(attrPath) ? readFileSync(attrPath, 'utf8') : '').toBe('');
      expect(existsSync(markerFile)).toBe(false);

      store.close();
    });

    it('FIX-F C2: lệnh gate chạy node -e gọi git update-ref refs/heads/main <sha khác> → sau lượt main về sha ghim, phiên needs_owner có lý do; lượt sau KHÔNG coi main bẩn là gốc', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);
      const mainShaPinned = git(repo, 'rev-parse', 'refs/heads/main').trim();

      // Lệnh gate cố tình đổi refs/heads/main sang HEAD của nhánh goal
      deps.cfg.gate.commands.test =
        'node -e "require(\'node:child_process\').execFileSync(\'git\', [\'update-ref\', \'refs/heads/main\', \'HEAD\'])"';

      const { runner } = createFakeRunner([
        // PM
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
        },
        // Dev
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Gate tamper main test'], { approved: true });

      expect(outcome.status).toBe('needs_owner');
      expect(outcome.notes).toContain('protected_branch_moved');
      expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(mainShaPinned);
      expect(store.getSetting(`protected_sha:${repo}`)).toBe(mainShaPinned);

      // Giả sử ngoài BTM có commit/merge dịch refs/heads/main sang sha mới trước khi resume:
      // snapshotTurn lúc started lượt KHÔNG tự update-ref main, không chạy lượt, dừng needs_owner kèm sha ghim → sha hiện tại
      const dirtySha = headSha(repo);
      expect(dirtySha).not.toBe(mainShaPinned);
      git(repo, 'update-ref', 'refs/heads/main', dirtySha);

      let resumeTurnRan = false;
      deps.runner = async () => {
        resumeTurnRan = true;
        return { exitCode: 0, timedOut: false, output: '', lastMessage: '', durationMs: 1 };
      };

      const resumeOutcome = await resumeSession(deps, outcome.sessionId!);
      expect(resumeOutcome.status).toBe('needs_owner');
      expect(resumeOutcome.notes).toContain('protected_branch_moved');
      expect(resumeOutcome.notes.join(' ')).toContain(`${mainShaPinned} → ${dirtySha}`);
      expect(resumeTurnRan).toBe(false);
      expect(git(repo, 'rev-parse', 'refs/heads/main').trim()).toBe(dirtySha);
      expect(store.getSetting(`protected_sha:${repo}`)).toBe(mainShaPinned);

      store.close();
    });

    it('C5: resumeSession từ chối goal đã approved/merged (goal_already_merged, không đổi state) và bỏ qua goal đã merged trong phiên nhiều goal', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      const gApproved = store.createGoal(repo, 'Approved Goal');
      const gMerged = store.createGoal(repo, 'Merged Goal');
      store.setGoalState(repo, gApproved.n, 'approved', 'owner');
      store.setGoalState(repo, gMerged.n, 'merged', 'owner');

      deps.runner = vi.fn();
      for (const g of [gApproved, gMerged]) {
        const sId = store.createSession([String(g.n)], repo);
        store.setSessionStatus(sId, 'needs_owner');
        const beforeState = store.getGoal(repo, g.n)?.state;
        const out = await resumeSession(deps, sId);
        expect(out).toMatchObject({
          status: 'needs_owner',
          sessionId: sId,
          notes: ['goal_already_merged'],
        });
        expect(store.getGoal(repo, g.n)?.state).toBe(beforeState);
      }
      expect(deps.runner).not.toHaveBeenCalled();

      // Phiên nhiều goal: G2 đã merged, G3 còn needs_owner → resume bỏ qua G2 (giữ nguyên merged) và chạy G3
      const g3 = store.createGoal(repo, 'Pending Goal 3');
      const multiSessionId = store.createSession([String(gMerged.n), String(g3.n)], repo);
      store.setSessionStatus(multiSessionId, 'needs_owner');

      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, { id: 'GTM-0001', goal: `G${g3.n}`, number: 1, of: 1 });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 3;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: `G${g3.n}`, number: 1, of: 1 }, agent);
        },
        () => makeQcResponse({ id: 'GTM-0001', goal: `G${g3.n}`, number: 1 }, 'pass'),
      ]);
      deps.runner = runner;

      const multiOut = await resumeSession(deps, multiSessionId);
      expect(multiOut.status).toBe('done');
      expect(store.getGoal(repo, gMerged.n)?.state).toBe('merged');
      expect(store.getGoal(repo, g3.n)?.state).toBe('qc_done');

      store.close();
    });

    it('C7: PM tạo ticket có depends_on không tồn tại hoặc số >= ticket đó → pm_ticket_bad_depends và dọn sạch', async () => {
      const repo = tmpRepo({ 'src/app.ts': 'export const a = 0;\n' });
      const { deps, store } = makeDeps(repo);

      // 1. depends_on trỏ tới ticket số lớn hơn (GTM-0001 depends_on GTM-0002)
      const { runner: runnerForward } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, {
            id: 'GTM-0001',
            goal: 'G1',
            number: 1,
            of: 2,
            depends_on: ['GTM-0002'],
          });
          writeTicketFile(cwd, {
            id: 'GTM-0002',
            goal: 'G1',
            number: 2,
            of: 2,
            depends_on: [],
          });
        },
      ]);
      deps.runner = runnerForward;

      const out1 = await runSession(deps, ['Bad depends forward'], { approved: true });
      expect(out1.status).toBe('needs_owner');
      expect(out1.notes).toContain('pm_ticket_bad_depends');
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0001.md'))).toBe(false);
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0002.md'))).toBe(false);
      expect(store.getTicketState(repo, 'GTM-0001')).toBeNull();
      expect(store.nextTicketSeq(repo)).toBe(1);

      // 2. depends_on trỏ tới ID không tồn tại trong goal (GTM-9999)
      const { runner: runnerMissing } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, {
            id: 'GTM-0001',
            goal: 'G2',
            number: 1,
            of: 1,
            depends_on: ['GTM-9999'],
          });
        },
      ]);
      deps.runner = runnerMissing;

      const out2 = await runSession(deps, ['Bad depends missing'], { approved: true });
      expect(out2.status).toBe('needs_owner');
      expect(out2.notes).toContain('pm_ticket_bad_depends');
      expect(existsSync(join(repo, 'team', 'tickets', 'GTM-0001.md'))).toBe(false);
      expect(store.nextTicketSeq(repo)).toBe(1);

      store.close();
    });

    it('C8: lượt Dev tạo dist/x.js + coverage/ → xoá im lặng trước gate, ghi ignored_cleaned:<n>, gate vẫn chạy và ticket pass', async () => {
      const repo = tmpRepo({
        'src/app.ts': 'export const a = 0;\n',
        '.gitignore': 'node_modules/\ndist/\ncoverage/\n.env\n',
      });

      const { deps, store } = makeDeps(repo);
      // Lệnh gate xác nhận dist/x.js và coverage/ đã bị xoá TRƯỚC khi gate chạy, và tự sinh thêm coverage/gate.txt
      deps.cfg.gate.commands.test =
        'node -e "const fs=require(\'node:fs\'); if (fs.existsSync(\'dist/x.js\') || fs.existsSync(\'coverage/lcov.info\')) process.exit(1); fs.mkdirSync(\'coverage\', {recursive:true}); fs.writeFileSync(\'coverage/gate.txt\', \'ok\');"';

      const { runner } = createFakeRunner([
        (_s, _a, _p, cwd) => {
          writeTicketFile(cwd, {
            id: 'GTM-0001',
            goal: 'G1',
            number: 1,
            of: 1,
            scope: ['src/'],
          });
        },
        (_s, agent, _p, cwd) => {
          writeFileSync(join(cwd, 'src', 'app.ts'), 'export const a = 1;\n');
          mkdirSync(join(cwd, 'dist'), { recursive: true });
          writeFileSync(join(cwd, 'dist', 'x.js'), 'console.log(1);\n');
          mkdirSync(join(cwd, 'coverage'), { recursive: true });
          writeFileSync(join(cwd, 'coverage', 'lcov.info'), 'TN:\n');
          mkdirSync(join(cwd, 'node_modules', 'left-pad'), { recursive: true });
          writeFileSync(join(cwd, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
          writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
        },
        (_s, _a, _p, cwd) => {
          // Trước lượt QC, file coverage/gate.txt do gate sinh ra cũng đã bị xoá im lặng
          expect(existsSync(join(cwd, 'coverage', 'gate.txt'))).toBe(false);
          expect(existsSync(join(cwd, 'dist', 'x.js'))).toBe(false);
          expect(existsSync(join(cwd, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
          return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
        },
      ]);
      deps.runner = runner;

      const outcome = await runSession(deps, ['Dev build artifacts'], { approved: true });
      expect(outcome.status).toBe('done');
      expect(outcome.tasks['GTM-0001']).toBe('passed');
      expect(existsSync(join(repo, 'dist', 'x.js'))).toBe(false);
      expect(existsSync(join(repo, 'coverage', 'lcov.info'))).toBe(false);
      expect(existsSync(join(repo, 'node_modules', 'left-pad', 'index.js'))).toBe(true);

      const devTurn = store.listTurns(outcome.sessionId!).find((t) => t.seat === 'dev');
      expect(devTurn?.error).toContain('ignored_cleaned:');

      store.close();
    });

  });
});

describe('P5-T7: thay ghế khi hết Energy', () => {
  it('Dev chính hết Energy → dự phòng jenny code; QC jenny là coder → dự phòng elon QC', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, { seats_backup: { dev: ['jenny'], qc: ['elon'] } } as any);
    const calls: string[] = [];
    const { runner } = createFakeRunner([
      (_seat, agent, _prompt, cwd) => {
        calls.push(`pm:${agent}`);
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_seat, agent, _prompt, cwd) => {
        calls.push(`dev:${agent}`);
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      (_seat, agent) => {
        calls.push(`qc:${agent}`);
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;
    deps.gate = (agent: string) => (agent === 'jacky' ? { ok: false as const, reason: 'energy:5h còn 3%, hồi lúc 19:57' } : { ok: true as const });
    await runSession(deps, ['Build feature'], { approved: true });
    expect(calls).toEqual(['pm:elon', 'dev:jenny', 'qc:elon']);
    store.close();
  });

  it('mọi người ngồi được ghế Dev đều hết → dừng với all_agents_exhausted, Dev không chạy', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, { seats_backup: { dev: ['jenny'] } } as any);
    let devCalled = false;
    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => {
        devCalled = true;
        return { exitCode: 0, output: '' };
      },
    ]);
    deps.runner = runner;
    deps.gate = (agent: string) => (agent === 'elon' ? { ok: true as const } : { ok: false as const, reason: `energy:${agent} hết` });
    const outcome = await runSession(deps, ['Build feature'], { approved: true });
    expect(outcome.status).toBe('needs_owner');
    expect(devCalled).toBe(false);
    expect(outcome.notes[0]).toBe('all_agents_exhausted');
    expect(outcome.notes).toContain('energy:jacky hết');
    expect(outcome.notes).toContain('energy:jenny hết');
    store.close();
  });

  it('config: seats_backup trỏ agent lạ hoặc không được ngồi ghế → lỗi', async () => {
    const { ConfigSchema } = await import('../src/config.ts');
    const base = loadConfig('btm.config.yaml');
    expect(ConfigSchema.safeParse({ ...base, seats_backup: { dev: ['jenny'] } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ ...base, seats_backup: { dev: ['ghost'] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, seats_backup: { dev: ['elon'] } }).success).toBe(false);
  });
});

describe('P6-T2: hết hạn mức giữa lượt → tiếp tục bằng người dự phòng', () => {
  it('Dev (agy) báo RESOURCE_EXHAUSTED → lượt kết thúc usage_limit_hit, ghi giờ hồi; Tiếp tục → jenny code, elon QC', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, { seats_backup: { dev: ['jenny'], qc: ['elon'] } } as any);
    const calls: string[] = [];
    const { runner } = createFakeRunner([
      (_seat, agent, _prompt, cwd) => {
        calls.push(`pm:${agent}`);
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      (_seat, agent) => {
        calls.push(`dev:${agent}`);
        return { exitCode: 1, output: 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h0m0s.' };
      },
      (_seat, agent, _prompt, cwd) => {
        calls.push(`dev:${agent}`);
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      (_seat, agent) => {
        calls.push(`qc:${agent}`);
        return makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass');
      },
    ]);
    deps.runner = runner;
    deps.gate = () => ({ ok: true as const });
    const first = await runSession(deps, ['Build feature'], { approved: true });
    expect(first.status).toBe('needs_owner');
    expect(first.notes[0]).toBe('usage_limit_hit:jacky');
    const until = store.getSetting('usage_limited_until:jacky');
    expect(until && Date.parse(until)).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
    await resumeSession(deps, first.sessionId!);
    expect(calls).toEqual(['pm:elon', 'dev:jacky', 'dev:jenny', 'qc:elon']);
    store.close();
  });

  it('không có người dự phòng → phiên dừng với lý do usage_limited kèm giờ hồi, Dev không chạy lại', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    store.setSetting('usage_limited_until:jacky', new Date(Date.now() + 3600_000).toISOString());
    let devCalled = false;
    const { runner } = createFakeRunner([
      (_seat, _agent, _prompt, cwd) => {
        writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 });
      },
      () => { devCalled = true; return { exitCode: 0, output: '' }; },
    ]);
    deps.runner = runner;
    deps.gate = () => ({ ok: true as const });
    const out = await runSession(deps, ['Build feature'], { approved: true });
    expect(out.status).toBe('needs_owner');
    expect(devCalled).toBe(false);
    expect(out.notes[0]).toMatch(/^usage_limited:jacky resets \d{2}:\d{2}$/);
    store.close();
  });
});

describe('P7-T2: đổi tài khoản của cùng Worker trước khi đổi người', () => {
  it('jacky/default hết quota → lượt sau chạy jacky-b (ntfy 1 lần); cả hai hết + dự phòng jenny → jenny', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo, { seats_backup: { dev: ['jenny'], qc: ['elon'] } } as any);
    store.ensureDefaultAccounts(['elon', 'jacky', 'jenny']);
    store.addAccount('jacky', 'b', { active: true });
    store.addAccount('jacky', 'c', { active: false }); // ngủ: không bao giờ được chọn
    const sent: string[] = [];
    deps.notify = (ev) => sent.push(`${ev.kind}:${ev.notes?.[0]}`);
    const quota = { exitCode: 1, output: 'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h0m0s.' };
    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => { writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }); },
      () => quota,
      () => quota,
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;
    deps.gate = () => ({ ok: true as const });
    const first = await runSession(deps, ['Build feature'], { approved: true });
    expect(first.notes[0]).toBe('usage_limit_hit:jacky');
    expect(store.getSetting('usage_limited_until:jacky')).toBeTruthy();
    const second = await resumeSession(deps, first.sessionId!);
    expect(second.notes[0]).toBe('usage_limit_hit:jacky');
    expect(store.getSetting('usage_limited_until:jacky-b')).toBeTruthy();
    await resumeSession(deps, first.sessionId!);
    expect(calls.map((c) => `${c.seat}:${c.agentId}:${c.options?.account}`)).toEqual([
      'pm:elon:elon', 'dev:jacky:jacky', 'dev:jacky:jacky-b', 'dev:jenny:jenny', 'qc:elon:elon',
    ]);
    expect(sent).toEqual(['account_switch:jacky:default_to_b']);
    store.close();
  });

  it('gate energy của tài khoản đầu fail → dùng tài khoản kế tiếp của cùng Worker', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    store.ensureDefaultAccounts(['elon', 'jacky', 'jenny']);
    store.addAccount('jacky', 'b', { active: true });
    deps.notify = () => {};
    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => { writeTicketFile(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }); },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 }, agent);
      },
      () => makeQcResponse({ id: 'GTM-0001', goal: 'G1', number: 1 }, 'pass'),
    ]);
    deps.runner = runner;
    deps.gate = (key) => (key === 'jacky' ? { ok: false as const, reason: 'energy:5h 3% left' } : { ok: true as const });
    const out = await runSession(deps, ['Build feature'], { approved: true });
    expect(out.tasks['GTM-0001']).toBe('passed');
    expect(calls[1]!.options?.account).toBe('jacky-b');
    store.close();
  });
});

describe('P6-T3/T4: câu hỏi chặn ticket, ghi chú của anh vào lượt Dev', () => {
  it('Dev trả BLOCKED nhưng report có "Cần xác nhận …?" → vẫn ghi câu hỏi, ticket returned (không kẹt blocked)', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const t1 = { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 };
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => { writeTicketFile(cwd, { ...t1, scope: ['src/app.ts'] } as any); },
      (_s, agent, _p, cwd) => {
        writeDevReport(cwd, t1, agent, 'Số lượt đoán tối đa là bao nhiêu?');
        return { lastMessage: 'BLOCKED: chờ anh Zon chốt' } as any;
      },
    ]);
    deps.runner = runner;
    deps.gate = () => ({ ok: true as const });
    const out = await runSession(deps, ['Build feature'], { approved: true });
    expect(out.status).toBe('needs_owner');
    expect(out.notes[0]).toBe('questions_open:1');
    expect(store.getTicketState(repo, 'GTM-0001')?.state).toBe('returned');
    expect(store.listQuestions(repo, 'open').map((q) => q.text)).toEqual(['Số lượt đoán tối đa là bao nhiêu?']);
    store.close();
  });

  it('Dev hỏi (có ?) → code giữ, ticket returned, goal dừng questions_open (ticket khác chưa chạy); trả lời → Dev làm tiếp, QC xem toàn bộ', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1', 'src/b.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const prompts: string[] = [];
    const t1 = { id: 'GTM-0001', goal: 'G1', number: 1, of: 2 };
    const t2 = { id: 'GTM-0002', goal: 'G1', number: 2, of: 2 };
    const { runner, calls } = createFakeRunner([
      (_s, _a, _p, cwd) => {
        writeTicketFile(cwd, { ...t1, scope: ['src/app.ts'] } as any);
        writeTicketFile(cwd, { ...t2, scope: ['src/b.ts'] } as any);
      },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, t1, agent, 'Dùng SQLite hay PostgreSQL?');
      },
    ]);
    deps.runner = runner;
    deps.gate = () => ({ ok: true as const });
    const out = await runSession(deps, ['Build feature'], { approved: true });
    expect(out.status).toBe('needs_owner');
    expect(out.notes[0]).toBe('questions_open:1');
    expect(calls.map((c) => c.seat)).toEqual(['pm', 'dev']);
    expect(store.getTicketState(repo, 'GTM-0001')?.state).toBe('returned');
    const baseBefore = store.getTicketState(repo, 'GTM-0001')?.base_sha;
    expect(baseBefore).toBeTruthy();
    const q = store.listQuestions(repo, 'open');
    expect(q.map((x) => [x.ticket, x.seat, x.text])).toEqual([['GTM-0001', 'dev', 'Dùng SQLite hay PostgreSQL?']]);

    // Chưa trả lời → Tiếp tục vẫn dừng, không chạy Dev
    const sid = out.sessionId!;
    const { runner: r0, calls: c0 } = createFakeRunner([]);
    deps.runner = r0;
    const again = await resumeSession(deps, sid);
    expect(again.notes[0]).toBe('questions_open:1');
    expect(c0).toHaveLength(0);

    store.answerQuestion(q[0]!.id, 'SQLite');
    store.addLineNote(repo, 'GTM-0001', 'src/app.ts', 1, 'đổi tên biến app');
    const { runner: r2, calls: c2 } = createFakeRunner([
      (_s, agent, prompt, cwd) => {
        prompts.push(prompt);
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 3;\n');
        writeDevReport(cwd, t1, agent, 'Dùng SQLite hay PostgreSQL?'); // câu cũ lặp lại → không hỏi lại
      },
      () => makeQcResponse(t1, 'pass'),
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 2;\n');
        writeDevReport(cwd, t2, agent);
      },
      () => makeQcResponse(t2, 'pass'),
    ]);
    deps.runner = r2;
    const sid2 = store.createSession(['1'], repo);
    store.setSessionStatus(sid2, 'needs_owner');
    const out2 = await resumeSession(deps, sid2);
    expect(c2.map((c) => c.seat)).toEqual(['dev', 'qc', 'dev', 'qc']);
    expect(prompts[0]).toContain('Anh Zon trả lời: SQLite');
    expect(prompts[0]).toContain('Anh Zon (src/app.ts:1): đổi tên biến app');
    // câu trả lời đã dùng ở lượt Dev vẫn đi kèm lượt QC (QC không chấm fail vì ticket ghi "chưa chốt")
    expect(c2[1]!.prompt).toContain('Anh Zon đã chốt (đúng hơn chỗ ticket ghi "chưa chốt"): Hỏi: Dùng SQLite hay PostgreSQL? → Anh Zon trả lời: SQLite');
    expect(c2[3]!.prompt).not.toContain('Anh Zon đã chốt');
    expect(store.getTicketState(repo, 'GTM-0001')?.base_sha).toBe(baseBefore); // QC vẫn xem toàn bộ base..HEAD
    expect(out2.tasks['GTM-0001']).toBe('passed');
    expect(store.listQuestions(repo, 'used')).toHaveLength(1);
    expect(store.listLineNotes(repo, 'GTM-0001', true)).toHaveLength(0);
    store.close();
  });

  it('báo cáo "Cần xác nhận: Không có câu hỏi" và QC confirm có ? không chặn ticket', async () => {
    const repo = tmpRepo({ 'src/app.ts': '1' });
    const { deps, store } = makeDeps(repo);
    const t1 = { id: 'GTM-0001', goal: 'G1', number: 1, of: 1 };
    const { runner } = createFakeRunner([
      (_s, _a, _p, cwd) => { writeTicketFile(cwd, t1); },
      (_s, agent, _p, cwd) => {
        writeFileSync(join(cwd, 'src', 'app.ts'), 'export const app = 2;\n');
        writeDevReport(cwd, t1, agent, 'Không có câu hỏi');
      },
      () => makeQcResponse(t1, 'pass', [], [], ['Đã test trên Chrome?']),
    ]);
    deps.runner = runner;
    deps.gate = () => ({ ok: true as const });
    const out = await runSession(deps, ['Build feature'], { approved: true });
    expect(out.tasks['GTM-0001']).toBe('passed');
    expect(store.listQuestions(repo)).toHaveLength(0);
    store.close();
  });
});
