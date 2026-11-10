import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Seat } from '../config.ts';
import { git, headSha, commitAll } from '../git.ts';
import type { Store } from '../store/db.ts';

export interface TurnGuardSnapshot {
  goalBranch: string;
  preHead: string;
  protectedBranch: string;
  protectedHead: string;
  otherGoalBranches?: Record<string, string>;
  seat?: Seat;
  gitConfig?: string;
  gitInfoAttributes?: string;
  protectedBranchMoved?: boolean;
  protectedBranchActualSha?: string;
  ignoredFiles?: string[];
  ignoredListFailed?: boolean;
}

export interface GuardTurnResult {
  switchedBranch: boolean;
  headChanged: boolean;
  treeDirty: boolean;
  modifiedProtectedBranch: boolean;
  modifiedOtherGoal?: boolean;
  gitConfigTampered?: boolean;
  protectedBranchMoved?: boolean;
  ignoredCleanedCount?: number;
  ignoredListFailed?: boolean;
  needsOwner?: string;
}

function turnGuardKey(repo: string): string {
  return `turn_guard:${repo}`;
}

export function protectedShaKey(repo: string): string {
  return `protected_sha:${repo}`;
}

function readFileOrEmpty(filePath: string): string {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

export function restoreTicketFilesFromBase(repo: string, baseRef: string): void {
  try {
    git(repo, 'reset', 'HEAD', '--', 'team/tickets');
  } catch {}
  try {
    rmSync(join(repo, 'team', 'tickets'), { recursive: true, force: true });
  } catch {}
  try {
    const out = git(repo, 'ls-tree', '-r', '--name-only', '-z', baseRef, '--', 'team/tickets');
    if (out) {
      for (const relPath of out.split('\0')) {
        if (!relPath) continue;
        const content = git(repo, 'show', `${baseRef}:${relPath}`);
        const fullPath = join(repo, relPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, 'utf8');
      }
    }
  } catch {}
}

function listIgnoredFilesOutsideNodeModules(repo: string): { files: string[]; failed: boolean } {
  try {
    const out = git(
      repo,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      // KHÔNG --directory: kèm pathspec loại trừ, git liệt kê cả thư mục cha (vd packages/) → xoá nhầm source.
      '-z',
      '--',
      '.',
      ':(exclude,glob)**/node_modules/**',
      ':(exclude)node_modules'
    );
    const files = out
      .split('\0')
      .map((p) => p.replace(/\\/g, '/'))
      .filter(Boolean)
      .filter((p) => !p.split('/').includes('node_modules'))
      .sort();
    return { files, failed: false };
  } catch {
    return { files: [], failed: true };
  }
}

function isIgnoredDir(repo: string, dir: string): boolean {
  try {
    git(repo, 'check-ignore', '-q', '--', `${dir}/`);
    return true;
  } catch {
    return false;
  }
}

// shortcut: không phát hiện agent sửa file trong node_modules; khi cần thì gate chạy trên bản checkout sạch + npm ci.
export function cleanNewIgnoredFiles(
  repo: string,
  snapshot: TurnGuardSnapshot
): { cleanedCount: number; listFailed: boolean } {
  let cleanedCount = 0;
  let listFailed = Boolean(snapshot.ignoredListFailed);

  if (snapshot.ignoredFiles !== undefined) {
    const preSet = new Set(snapshot.ignoredFiles);
    // Thư mục ignored đã có từ trước (vd .venv/) → giữ mọi file mới bên trong (xoá lẻ sẽ hỏng venv).
    const preIgnoredDirs = new Set<string>();
    for (const p of snapshot.ignoredFiles) {
      const top = p.split('/')[0];
      if (p.includes('/') && !preIgnoredDirs.has(top) && isIgnoredDir(repo, top)) preIgnoredDirs.add(top);
    }
    const currentIgnored = listIgnoredFilesOutsideNodeModules(repo);
    listFailed ||= currentIgnored.failed;
    // Chỉ xoá đúng từng FILE ignored mới – không bao giờ xoá thư mục (vd src/foo.log mới không được kéo theo src/).
    for (const relPath of currentIgnored.files) {
      if (preSet.has(relPath) || preIgnoredDirs.has(relPath.split('/')[0])) continue;
      cleanedCount++;
      try {
        rmSync(join(repo, relPath), { force: true });
      } catch {}
    }
  }
  return { cleanedCount, listFailed };
}

export function snapshotTurn(
  repo: string,
  goalBranch: string,
  protectedBranch?: string,
  store?: Pick<Store, 'setSetting'> & Partial<Pick<Store, 'getSetting'>>,
  seat?: Seat
): TurnGuardSnapshot {
  const gitConfig = readFileOrEmpty(join(repo, '.git', 'config'));
  const gitInfoAttributes = readFileOrEmpty(join(repo, '.git', 'info', 'attributes'));
  const ignoredListing = listIgnoredFilesOutsideNodeModules(repo);

  const prot = protectedBranch || 'main';
  const protRef = prot.startsWith('refs/heads/') ? prot : `refs/heads/${prot}`;
  let currentProtectedHead = '';
  try {
    currentProtectedHead = git(repo, 'rev-parse', protRef).trim();
  } catch {}

  let protectedHead = currentProtectedHead;
  let protectedBranchMoved = false;

  if (store && typeof store.getSetting === 'function') {
    const pinKey = protectedShaKey(repo);
    const pinnedSha = store.getSetting(pinKey)?.trim() || '';
    if (pinnedSha) {
      protectedHead = pinnedSha;
      if (currentProtectedHead !== pinnedSha) {
        protectedBranchMoved = true;
      }
    } else if (currentProtectedHead) {
      store.setSetting(pinKey, currentProtectedHead);
      protectedHead = currentProtectedHead;
    }
  }

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

  const snapshot: TurnGuardSnapshot = {
    goalBranch,
    preHead: headSha(repo),
    protectedBranch: prot,
    protectedHead,
    otherGoalBranches,
    gitConfig,
    gitInfoAttributes,
    ...(ignoredListing.failed
      ? { ignoredListFailed: true }
      : { ignoredFiles: ignoredListing.files }),
    ...(protectedBranchMoved
      ? { protectedBranchMoved: true, protectedBranchActualSha: currentProtectedHead }
      : {}),
  };
  if (seat) {
    snapshot.seat = seat;
  }
  if (store && seat && !protectedBranchMoved) {
    store.setSetting(turnGuardKey(repo), JSON.stringify(snapshot));
  }
  return snapshot;
}

export function guardStoredAgentTurn(
  store: Pick<Store, 'setSetting'>,
  repo: string,
  snapshot: TurnGuardSnapshot,
  seat: Seat,
  options?: Parameters<typeof guardAgentTurn>[3]
): GuardTurnResult {
  try {
    return guardAgentTurn(repo, snapshot, seat, options);
  } finally {
    store.setSetting(turnGuardKey(repo), '');
  }
}

export function recoverInterruptedTurn(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  repo: string
): GuardTurnResult | null {
  const raw = store.getSetting(turnGuardKey(repo));
  if (!raw) {
    return null;
  }

  const snapshot = JSON.parse(raw) as TurnGuardSnapshot;
  const seat = snapshot.seat;
  if (!seat || !['pm', 'dev', 'qc', 'audit'].includes(seat)) {
    store.setSetting(turnGuardKey(repo), '');
    throw new Error('Invalid persisted turn guard snapshot');
  }
  if (snapshot.protectedBranch && snapshot.protectedHead) {
    const protectedRef = snapshot.protectedBranch.startsWith('refs/heads/')
      ? snapshot.protectedBranch
      : `refs/heads/${snapshot.protectedBranch}`;
    let currentProtectedHead = '';
    try {
      currentProtectedHead = git(repo, 'rev-parse', protectedRef).trim();
    } catch {}
    if (currentProtectedHead !== snapshot.protectedHead) {
      if (snapshot.gitConfig !== undefined) {
        writeFileSync(join(repo, '.git', 'config'), snapshot.gitConfig, 'utf8');
      }
      const goalBranch = snapshot.goalBranch.replace(/^refs\/heads\//, '');
      git(repo, 'checkout', '-f', goalBranch);
      store.setSetting(turnGuardKey(repo), '');
      return {
        switchedBranch: true,
        headChanged: false,
        treeDirty: false,
        modifiedProtectedBranch: false,
        protectedBranchMoved: true,
        needsOwner: 'recovered_interrupted_turn',
      };
    }
  }
  return guardStoredAgentTurn(store, repo, snapshot, seat);
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
  // 0. C1: Khôi phục .git/config và .git/info/attributes TRƯỚC mọi lệnh git khác.
  let gitConfigTampered = false;
  if (snapshot.gitConfig !== undefined || snapshot.gitInfoAttributes !== undefined) {
    const gitConfigPath = join(repo, '.git', 'config');
    const gitAttributesPath = join(repo, '.git', 'info', 'attributes');
    const expectedConfig = snapshot.gitConfig ?? '';
    const expectedAttributes = snapshot.gitInfoAttributes ?? '';
    const currentConfig = readFileOrEmpty(gitConfigPath);
    const currentAttributes = readFileOrEmpty(gitAttributesPath);

    const withoutHooksPath = (config: string) =>
      config.replace(/^\s*hooksPath\s*=.*(?:\r?\n|$)/gim, '');
    if (currentConfig !== expectedConfig) {
      gitConfigTampered = true;
      if (expectedConfig === '') {
        try {
          rmSync(gitConfigPath, { force: true });
        } catch {}
      } else {
        mkdirSync(join(repo, '.git'), { recursive: true });
        writeFileSync(gitConfigPath, expectedConfig, 'utf8');
      }
      if (withoutHooksPath(currentConfig) === withoutHooksPath(expectedConfig)) {
        gitConfigTampered = false;
      }
    }

    if (currentAttributes !== expectedAttributes) {
      gitConfigTampered = true;
      if (expectedAttributes === '') {
        try {
          rmSync(gitAttributesPath, { force: true });
        } catch {}
      } else {
        mkdirSync(join(repo, '.git', 'info'), { recursive: true });
        writeFileSync(gitAttributesPath, expectedAttributes, 'utf8');
      }
    }
  }

  // 1. Kiểm tra sha protected branch ≠ protectedHead:
  // Agent vi phạm → git update-ref refs/heads/<protected> <protectedHead> (không đổi working tree)
  // TRƯỚC khi checkout nhánh goal.
  // B7: main bị xoá trong lượt → tạo lại bằng update-ref, vi phạm agent_modified_protected_branch.
  let modifiedProtectedBranch = false;
  let protectedBranchMoved = Boolean(snapshot.protectedBranchMoved);
  if (snapshot.protectedBranch && snapshot.protectedHead) {
    const protRef = snapshot.protectedBranch.startsWith('refs/heads/')
      ? snapshot.protectedBranch
      : `refs/heads/${snapshot.protectedBranch}`;
    try {
      const currentProtectedSha = git(repo, 'rev-parse', protRef).trim();
      if (currentProtectedSha !== snapshot.protectedHead) {
        modifiedProtectedBranch = true;
        protectedBranchMoved = true;
        git(repo, 'update-ref', protRef, snapshot.protectedHead);
      }
    } catch {
      modifiedProtectedBranch = true;
      protectedBranchMoved = true;
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

  let ignoredCleanedCount = 0;
  let ignoredListFailed = Boolean(snapshot.ignoredListFailed);

  if (seat === 'pm' || seat === 'dev') {
    if (modifiedProtectedBranch || modifiedOtherGoal || gitConfigTampered || protectedBranchMoved) {
      try {
        git(repo, 'reset', '--hard', snapshot.preHead);
        git(repo, 'clean', '-fd');
      } catch {}
    } else {
      if (headChanged) {
        git(repo, 'reset', '--soft', snapshot.preHead);
      }
      if (options?.isErrorOrTimeoutOrAbort) {
        if (seat === 'dev') {
          restoreTicketFilesFromBase(repo, snapshot.preHead);
        }
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
    const cleaned = cleanNewIgnoredFiles(repo, snapshot);
    ignoredCleanedCount = cleaned.cleanedCount;
    ignoredListFailed = cleaned.listFailed;
  } else if (seat === 'qc' || seat === 'audit') {
    // 4. qc/audit: vi phạm qc_modified_repo / audit_modified_repo / agent_modified_protected_branch / agent_modified_other_goal → reset --hard <head> + clean
    if (
      headChanged ||
      treeDirty ||
      switchedBranch ||
      modifiedProtectedBranch ||
      modifiedOtherGoal ||
      gitConfigTampered ||
      protectedBranchMoved
    ) {
      try {
        git(repo, 'reset', '--hard', snapshot.preHead);
        git(repo, 'clean', '-fd');
      } catch {}
    }
    const cleaned = cleanNewIgnoredFiles(repo, snapshot);
    ignoredCleanedCount = cleaned.cleanedCount;
    ignoredListFailed = cleaned.listFailed;
  }

  return {
    switchedBranch,
    headChanged,
    treeDirty,
    modifiedProtectedBranch,
    modifiedOtherGoal,
    gitConfigTampered,
    protectedBranchMoved,
    ignoredCleanedCount,
    ignoredListFailed,
  };
}
