import type { Seat } from '../config.ts';
import { git, headSha, commitAll } from '../git.ts';

export interface TurnGuardSnapshot {
  goalBranch: string;
  preHead: string;
  protectedBranch: string;
  protectedHead: string;
  otherGoalBranches?: Record<string, string>;
}

export interface GuardTurnResult {
  switchedBranch: boolean;
  headChanged: boolean;
  treeDirty: boolean;
  modifiedProtectedBranch: boolean;
  modifiedOtherGoal?: boolean;
}

export function snapshotTurn(repo: string, goalBranch: string, protectedBranch?: string): TurnGuardSnapshot {
  const prot = protectedBranch || 'main';
  const protRef = prot.startsWith('refs/heads/') ? prot : `refs/heads/${prot}`;
  let protectedHead = '';
  try {
    protectedHead = git(repo, 'rev-parse', protRef).trim();
  } catch {}

  const otherGoalBranches: Record<string, string> = {};
  const currentGoalRef = goalBranch.startsWith('refs/heads/') ? goalBranch : `refs/heads/${goalBranch}`;
  try {
    const refsOut = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/goal/').trim();
    if (refsOut) {
      for (const line of refsOut.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const ref = parts[0];
          const sha = parts[1];
          if (ref !== currentGoalRef) {
            otherGoalBranches[ref] = sha;
          }
        }
      }
    }
  } catch {}

  return {
    goalBranch,
    preHead: headSha(repo),
    protectedBranch: prot,
    protectedHead,
    otherGoalBranches,
  };
}

export function guardAgentTurn(
  repo: string,
  snapshot: TurnGuardSnapshot,
  seat: Seat,
  options?: {
    isErrorOrTimeoutOrAbort?: boolean;
    taskId?: string;
    author?: { name: string; email: string };
    reason?: string;
  }
): GuardTurnResult {
  // 1. Kiểm tra sha protected branch ≠ protectedHead:
  // Agent vi phạm → git update-ref refs/heads/<protected> <protectedHead> (không đổi working tree)
  // TRƯỚC khi checkout nhánh goal.
  // B7: main bị xoá trong lượt → tạo lại bằng update-ref, vi phạm agent_modified_protected_branch.
  let modifiedProtectedBranch = false;
  if (snapshot.protectedBranch && snapshot.protectedHead) {
    const protRef = snapshot.protectedBranch.startsWith('refs/heads/')
      ? snapshot.protectedBranch
      : `refs/heads/${snapshot.protectedBranch}`;
    try {
      const currentProtectedSha = git(repo, 'rev-parse', protRef).trim();
      if (currentProtectedSha !== snapshot.protectedHead) {
        modifiedProtectedBranch = true;
        git(repo, 'update-ref', protRef, snapshot.protectedHead);
      }
    } catch {
      modifiedProtectedBranch = true;
      git(repo, 'update-ref', protRef, snapshot.protectedHead);
    }
  }

  // B2: Kiểm tra các nhánh goal khác: nếu bị sửa/xoá/tạo mới → khôi phục bằng update-ref (xoá nhánh mới tạo)
  let modifiedOtherGoal = false;
  const rawGoalName = snapshot.goalBranch.replace(/^refs\/heads\//, '');
  const goalRef = `refs/heads/${rawGoalName}`;

  if (snapshot.otherGoalBranches) {
    const currentRefs = new Map<string, string>();
    try {
      const refsOut = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/goal/').trim();
      if (refsOut) {
        for (const line of refsOut.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            currentRefs.set(parts[0], parts[1]);
          }
        }
      }
    } catch {}

    for (const [ref, expectedSha] of Object.entries(snapshot.otherGoalBranches)) {
      const curSha = currentRefs.get(ref);
      if (!curSha || curSha !== expectedSha) {
        modifiedOtherGoal = true;
        git(repo, 'update-ref', ref, expectedSha);
      }
    }

    for (const [curRef] of currentRefs.entries()) {
      if (curRef !== goalRef && !Object.hasOwn(snapshot.otherGoalBranches, curRef)) {
        modifiedOtherGoal = true;
        git(repo, 'update-ref', '-d', curRef);
      }
    }
  }

  // 2. Nhánh hiện tại ≠ nhánh goal → git checkout -f <nhánh goal>
  // B7: Nhánh goal bị xoá trong lượt → tạo lại tại preHead rồi checkout, vi phạm agent_switched_branch.
  let goalRefExists = true;
  try {
    git(repo, 'rev-parse', '--verify', goalRef);
  } catch {
    goalRefExists = false;
  }

  let switchedBranch = false;
  let headSymbolic = '';
  try {
    headSymbolic = git(repo, 'symbolic-ref', 'HEAD').trim();
  } catch {}

  if (!goalRefExists) {
    git(repo, 'update-ref', goalRef, snapshot.preHead);
    git(repo, 'checkout', '-f', rawGoalName);
    switchedBranch = true;
  } else if (headSymbolic !== goalRef) {
    git(repo, 'checkout', '-f', rawGoalName);
    switchedBranch = true;
  }

  // Đảm bảo lại protected branch đã về đúng protectedHead sau khi checkout
  if (snapshot.protectedBranch && snapshot.protectedHead) {
    const protRef = snapshot.protectedBranch.startsWith('refs/heads/')
      ? snapshot.protectedBranch
      : `refs/heads/${snapshot.protectedBranch}`;
    try {
      const curSha = git(repo, 'rev-parse', protRef).trim();
      if (curSha !== snapshot.protectedHead) {
        git(repo, 'update-ref', protRef, snapshot.protectedHead);
      }
    } catch {
      git(repo, 'update-ref', protRef, snapshot.protectedHead);
    }
  }

  // 3. HEAD nhánh goal khác head trước lượt (agent tự commit)
  const currentHead = headSha(repo);
  const headChanged = currentHead !== snapshot.preHead;
  const treeDirty = Boolean(git(repo, 'status', '--porcelain').trim());

  if (seat === 'pm' || seat === 'dev') {
    if (modifiedProtectedBranch || modifiedOtherGoal) {
      try {
        git(repo, 'reset', '--hard', snapshot.preHead);
        git(repo, 'clean', '-fd');
      } catch {}
    } else {
      if (headChanged) {
        git(repo, 'reset', '--soft', snapshot.preHead);
      }
      if (options?.isErrorOrTimeoutOrAbort) {
        const dirtyNow = Boolean(git(repo, 'status', '--porcelain').trim());
        if (dirtyNow && options.author && options.reason) {
          try {
            if (seat === 'dev' && options.taskId) {
              commitAll(repo, `${options.taskId}: WIP ${options.reason}`, options.author);
            } else if (seat === 'pm') {
              const prefix = options.taskId ? `${options.taskId}: ` : '';
              commitAll(repo, `${prefix}WIP ${options.reason}`, options.author);
            }
          } catch {}
        }
      }
    }
  } else if (seat === 'qc' || seat === 'audit') {
    // 4. qc/audit: vi phạm qc_modified_repo / audit_modified_repo / agent_modified_protected_branch / agent_modified_other_goal → reset --hard <head> + clean
    if (headChanged || treeDirty || switchedBranch || modifiedProtectedBranch || modifiedOtherGoal) {
      try {
        git(repo, 'reset', '--hard', snapshot.preHead);
        git(repo, 'clean', '-fd');
      } catch {}
    }
  }

  return {
    switchedBranch,
    headChanged,
    treeDirty,
    modifiedProtectedBranch,
    modifiedOtherGoal,
  };
}
