import { appendFileSync } from 'node:fs';
import type { Config, Seat } from '../config.ts';
import type { QueueItem, Store } from '../store/db.ts';
import type { Runner, TurnOutput } from '../runner/run.ts';
import type { createMonitor } from '../energy/monitor.ts';
import { directPrompt, askPrompt } from '../core/prompts.ts';
import { knowledgeFor } from '../knowledge/digest.ts';
import { git, commitAll } from '../git.ts';
import { snapshotTurn, guardStoredAgentTurn, restoreTicketFilesFromBase } from '../core/guard.ts';
import { seatOpts, usableAccounts } from '../agents/accounts.ts';
import { saveAnswer } from './ask-lane.ts';

// Lệnh trực tiếp trong hàng đợi (Dev / QC / PM / Audit / "ask-<ghế>"), tách khỏi host.ts 2026-11-14
// (docs/engineering-rules.md: một hàm chạy lượt dùng chung, mỗi nhánh chỉ giữ phần khác biệt). Không đổi hành vi.

export interface DirectCtx {
  cfg: Config;
  store: Store;
  runner: Runner;
  monitor?: ReturnType<typeof createMonitor>;
  signal: AbortSignal;
  item: QueueItem;
  project: string;
  sessionId: number;
  turnId: number;
  taskId: string;
  logFile: string;
  agent: string;
  /** Ghế ghi lượt (ask-<ghế> → ghế đó). */
  turnSeat: Seat;
  askSeat: Seat | null;
}

/** done/error: host đặt trạng thái phiên = kết quả. ownSession: nhánh đã tự đặt trạng thái phiên (giữ nguyên). */
export type DirectResult = { result: 'done' | 'error'; ownSession: boolean };

type RunKind = 'ok' | 'timeout' | 'exit' | 'error' | 'abort';

/** Chạy agent một lần và quy kết quả về một loại. */
async function runOnce(c: DirectCtx, runnerSeat: Seat, prompt: string, account: string | undefined) {
  let output: TurnOutput | null = null;
  let runError: any = null;
  try {
    output = await c.runner(runnerSeat, c.agent, prompt, c.project, c.logFile, { signal: c.signal, account });
  } catch (err: any) {
    runError = err;
  }
  const isAbort = c.signal.aborted || runError?.name === 'AbortError';
  let kind: RunKind;
  let reason: string;
  if (runError) { kind = isAbort ? 'abort' : 'error'; reason = isAbort ? 'aborted' : (runError?.message || String(runError)); }
  else if (isAbort) { kind = 'abort'; reason = 'aborted'; }
  else if (output!.timedOut) { kind = 'timeout'; reason = 'timeout'; }
  else if (output!.exitCode !== 0) { kind = 'exit'; reason = `exit_${output!.exitCode}`; }
  else { kind = 'ok'; reason = ''; }
  return { kind, reason, output, thrown: Boolean(runError) };
}

/** Dừng trước khi chạy agent: lượt lỗi, ghi handoff, phiên lỗi, huỷ hàng đợi. */
function fail(c: DirectCtx, reason: string, recordHandoff = true): DirectResult {
  c.store.endTurn(c.turnId, 'error', reason);
  if (recordHandoff) c.store.recordHandoffFailure(c.sessionId, c.taskId, reason);
  c.store.setSessionStatus(c.sessionId, 'error');
  c.store.setQueueStatus(c.item.id, 'cancelled');
  return { result: 'error', ownSession: true };
}

const noteOf = (g: { ignoredListFailed?: boolean; ignoredCleanedCount?: number }) =>
  g.ignoredListFailed ? 'ignored_list_failed' : (g.ignoredCleanedCount ?? 0) > 0 ? `ignored_cleaned:${g.ignoredCleanedCount}` : undefined;

/** PM / Audit / ask-<ghế>: CHỈ ĐỌC; repo đổi → bỏ (readonly_cmd_modified_repo). */
async function runReadOnly(c: DirectCtx): Promise<DirectResult> {
  if (!c.agent) {
    c.store.endTurn(c.turnId, 'error', 'no_agent_on_seat');
    c.store.setQueueStatus(c.item.id, 'cancelled');
    return { result: 'error', ownSession: false };
  }
  const headBefore = git(c.project, 'rev-parse', 'HEAD').trim();
  const treeBefore = git(c.project, 'status', '--porcelain').trim();
  // Ghế chạy chỉ đọc: audit giữ 'audit'; ghế khác chạy bằng 'qc' (READ_ONLY_SEATS), lượt vẫn ghi đúng ghế.
  const prompt = c.askSeat
    ? askPrompt(c.askSeat, c.item.text, knowledgeFor(c.store, c.cfg, c.project, c.item.text))
    : directPrompt(c.item.to, c.item.text);
  const r = await runOnce(c, c.turnSeat === 'audit' ? 'audit' : 'qc', prompt, usableAccounts(c.cfg, c.store, c.agent, new Date(), seatOpts(c.cfg, c.store, c.turnSeat === 'audit' ? 'audit' : 'qc', c.project))[0]?.key);
  if (r.kind === 'error' || r.kind === 'abort') {
    c.store.endTurn(c.turnId, 'error', r.reason);
    c.store.setQueueStatus(c.item.id, r.kind === 'abort' ? 'cancelled' : 'done');
    return { result: 'error', ownSession: false };
  }
  if (git(c.project, 'rev-parse', 'HEAD').trim() !== headBefore || git(c.project, 'status', '--porcelain').trim() !== treeBefore) {
    c.store.endTurn(c.turnId, 'rejected', 'readonly_cmd_modified_repo');
    c.store.setQueueStatus(c.item.id, 'done');
    return { result: 'error', ownSession: false };
  }
  if (r.kind !== 'ok') {
    c.store.endTurn(c.turnId, r.kind === 'timeout' ? 'timeout' : 'error', r.reason);
    c.store.setQueueStatus(c.item.id, 'done');
    return { result: 'error', ownSession: false };
  }
  c.store.endTurn(c.turnId, 'ok');
  c.store.setQueueStatus(c.item.id, 'done');
  // Khung chat History: câu trả lời hiện ngay dưới câu hỏi (2026-11-14).
  saveAnswer(c.store, c.project, { id: c.item.id, seat: c.turnSeat, asked: c.turnSeat, agent: c.agent, question: c.item.text }, r.output ?? {});
  return { result: 'done', ownSession: false };
}

/** Dev / QC: chạy trên nhánh goal, cây sạch, qua gate energy; Dev commit, QC không được sửa repo. */
async function runDevOrQc(c: DirectCtx): Promise<DirectResult> {
  const seat = c.item.to as 'dev' | 'qc';
  let currentBranch = '';
  try {
    currentBranch = git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  } catch (err: any) {
    c.store.endTurn(c.turnId, 'error', `git_error: ${err?.message || String(err)}`);
    c.store.recordHandoffFailure(c.sessionId, c.taskId, 'git_error');
    c.store.setSessionStatus(c.sessionId, 'error');
    c.store.setQueueStatus(c.item.id, 'cancelled');
    return { result: 'error', ownSession: true };
  }
  const protectedBranch = c.cfg.git.protected_branch || 'main';
  const goalMatch = currentBranch.match(/^goal\/G(\d+)(?:-.*)?$/);
  if (!goalMatch || currentBranch === protectedBranch) return fail(c, 'direct_cmd_needs_goal_branch');
  const goalN = goalMatch[1];
  if (seat === 'dev' && c.store.listTickets(c.project, `G${goalN}`).some((t) =>
    t.state === 'in_dev' || t.state === 'returned' || t.state === 'awaiting_qc' ||
    (t.state !== 'passed' && t.state !== 'cancelled' && Boolean(t.base_sha)))) {
    return fail(c, 'direct_cmd_ticket_in_progress');
  }
  if (git(c.project, 'status', '--porcelain').trim().length > 0) return fail(c, 'dirty_tree');

  // Plan 7: chạy dưới tài khoản dùng được đầu tiên của Worker qua được gate energy.
  let gateFailedReason: string | null = null;
  let account: string | undefined;
  if (c.agent) {
    const candidates = usableAccounts(c.cfg, c.store, c.agent, new Date(), seatOpts(c.cfg, c.store, seat, c.project));
    if (candidates.length === 0) gateFailedReason = `usage_limited:${c.agent}`;
    for (const cand of candidates) {
      if (c.monitor) {
        try { await c.monitor.refresh([cand.key]); } catch { /* refresh lỗi → coi như unknown */ }
        const gateCheck = c.monitor.gate(cand.key);
        if (!gateCheck.ok) { gateFailedReason = gateCheck.reason; continue; }
      }
      account = cand.key;
      gateFailedReason = null;
      break;
    }
  }
  if (gateFailedReason) {
    c.store.endTurn(c.turnId, 'error', gateFailedReason);
    c.store.recordHandoffFailure(c.sessionId, c.taskId, gateFailedReason);
    c.store.setQueueStatus(c.item.id, 'done');
    return { result: 'error', ownSession: false };
  }

  const snapshot = snapshotTurn(c.project, currentBranch, protectedBranch, c.store, seat);
  if (snapshot.protectedBranchMoved) return fail(c, 'protected_branch_moved');
  const author = { name: c.agent, email: `${c.agent}@btm.local` };
  const guardFail = (reason: string) => guardStoredAgentTurn(c.store, c.project, snapshot, seat,
    seat === 'dev' ? { isErrorOrTimeoutOrAbort: true, taskId: c.taskId, author, reason } : { isErrorOrTimeoutOrAbort: true });

  const r = await runOnce(c, seat, directPrompt(seat, c.item.text, c.cfg.runner.agy_allow_commands), account);
  if (r.kind === 'abort' || (r.kind === 'error' && r.thrown)) {
    c.store.endTurn(c.turnId, 'error', r.reason);
    guardFail(r.reason);
    c.store.setQueueStatus(c.item.id, r.kind === 'abort' ? 'cancelled' : 'done');
    c.store.setSessionStatus(c.sessionId, r.kind === 'abort' ? 'stopped' : 'error');
    return { result: 'error', ownSession: true };
  }
  if (seat === 'qc' && r.output?.lastMessage) {
    try { appendFileSync(c.logFile, `\n${r.output.lastMessage}\n`); } catch { /* log phụ */ }
  }
  if (r.kind === 'timeout' || r.kind === 'exit') {
    c.store.endTurn(c.turnId, r.kind === 'timeout' ? 'timeout' : 'error', r.reason);
    guardFail(r.reason);
    c.store.setQueueStatus(c.item.id, 'done');
    return { result: 'error', ownSession: false };
  }

  const guardRes = guardStoredAgentTurn(c.store, c.project, snapshot, seat);
  const reject = (reason: string): DirectResult => {
    c.store.endTurn(c.turnId, 'error', reason);
    c.store.recordHandoffFailure(c.sessionId, c.taskId, reason);
    c.store.setQueueStatus(c.item.id, 'done');
    return { result: 'error', ownSession: false };
  };
  if (guardRes.modifiedProtectedBranch) return reject('agent_modified_protected_branch');
  if (guardRes.switchedBranch) return reject('agent_switched_branch');
  if (seat === 'qc') {
    if (guardRes.headChanged || guardRes.treeDirty) return reject('qc_modified_repo');
    c.store.endTurn(c.turnId, 'ok', noteOf(guardRes));
    c.store.setQueueStatus(c.item.id, 'done');
    saveAnswer(c.store, c.project, { id: c.item.id, seat: 'qc', asked: 'qc', agent: c.agent, question: c.item.text }, r.output ?? {});
    return { result: 'done', ownSession: false };
  }
  restoreTicketFilesFromBase(c.project, snapshot.preHead);
  try {
    commitAll(c.project, `G${goalN}: cmd ${c.item.id}: ${c.item.text.slice(0, 60)}`, author);
  } catch (err: any) {
    const commitError = err?.message || String(err);
    c.store.endTurn(c.turnId, 'error', `commit_failed: ${commitError}`);
    try { appendFileSync(c.logFile, `\ncommitAll failed: ${commitError}\n`); } catch { /* log phụ */ }
    c.store.setQueueStatus(c.item.id, 'done');
    return { result: 'error', ownSession: false };
  }
  c.store.endTurn(c.turnId, 'ok', noteOf(guardRes));
  c.store.setQueueStatus(c.item.id, 'done');
  saveAnswer(c.store, c.project, { id: c.item.id, seat: 'dev', asked: 'dev', agent: c.agent, question: c.item.text }, r.output ?? {});
  return { result: 'done', ownSession: false };
}

export async function runDirectCommand(c: DirectCtx): Promise<DirectResult> {
  if (c.askSeat || c.item.to === 'pm' || c.item.to === 'audit') return runReadOnly(c);
  if (c.item.to === 'dev' || c.item.to === 'qc') return runDevOrQc(c);
  // Người nhận lạ: trước đây lượt + hàng đợi kẹt "running".
  c.store.endTurn(c.turnId, 'error', 'unknown_recipient');
  c.store.setQueueStatus(c.item.id, 'cancelled');
  return { result: 'error', ownSession: false };
}
