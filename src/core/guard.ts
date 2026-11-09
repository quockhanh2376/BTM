import type { Seat } from '../config.ts';
import { git, headSha, commitAll } from '../git.ts';

export interface TurnGuardSnapshot {
  goalBranch: string;
  preHead: string;
  protectedBranch: string;
  protectedHead: string;
}

export interface GuardTurnResult {
  switchedBranch: boolean;
  headChanged: boolean;
  treeDirty: boolean;
  modifiedProtectedBranch: boolean;
}

export function snapshotTurn(repo: string, goalBranch: string, protectedBranch?: string): TurnGuardSnapshot {
  const prot = protectedBranch || 'main';
  let protectedHead = '';
  try {
    protectedHead = git(repo, 'rev-parse', prot).trim();
  } catch {}
  return {
    goalBranch,
    preHead: headSha(repo),
    protectedBranch: prot,
    protectedHead,
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
  let modifiedProtectedBranch = false;
  if (snapshot.protectedBranch && snapshot.protectedHead) {
    try {
      const currentProtectedSha = git(repo, 'rev-parse', snapshot.protectedBranch).trim();
      if (currentProtectedSha !== snapshot.protectedHead) {
        modifiedProtectedBranch = true;
        const refName = snapshot.protectedBranch.startsWith('refs/')
          ? snapshot.protectedBranch
          : `refs/heads/${snapshot.protectedBranch}`;
        try {
          git(repo, 'update-ref', refName, snapshot.protectedHead);
        } catch {}
      }
    } catch {}
  }

  // 2. Nhánh hiện tại ≠ nhánh goal → git checkout -f <nhánh goal>
  // (không reset nhánh khác, không xoá nhánh agent tạo), lý do vi phạm agent_switched_branch.
  // Tuyệt đối không chạy reset --hard khi chưa chắc đang ở nhánh goal.
  const currentBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const switchedBranch = currentBranch !== snapshot.goalBranch;
  if (switchedBranch) {
    git(repo, 'checkout', '-f', snapshot.goalBranch);
  }

  // Đảm bảo lại protected branch đã về đúng protectedHead sau khi checkout
  if (modifiedProtectedBranch && snapshot.protectedBranch && snapshot.protectedHead) {
    try {
      const curSha = git(repo, 'rev-parse', snapshot.protectedBranch).trim();
      if (curSha !== snapshot.protectedHead) {
        const refName = snapshot.protectedBranch.startsWith('refs/')
          ? snapshot.protectedBranch
          : `refs/heads/${snapshot.protectedBranch}`;
        git(repo, 'update-ref', refName, snapshot.protectedHead);
      }
    } catch {}
  }

  // 3. HEAD nhánh goal khác head trước lượt (agent tự commit)
  const currentHead = headSha(repo);
  const headChanged = currentHead !== snapshot.preHead;
  const treeDirty = Boolean(git(repo, 'status', '--porcelain').trim());

  if (seat === 'pm' || seat === 'dev') {
    if (modifiedProtectedBranch) {
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
    // 4. qc/audit: vi phạm qc_modified_repo / audit_modified_repo / agent_modified_protected_branch → reset --hard <head> + clean
    // Áp dụng CẢ khi qc/audit timeout, exit≠0, abort (#3) – không bao giờ WIP-commit thay đổi của qc/audit.
    if (headChanged || treeDirty || switchedBranch || modifiedProtectedBranch) {
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
  };
}
