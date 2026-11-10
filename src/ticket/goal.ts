import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Store } from '../store/db.ts';
import { effectiveSeats } from '../store/db.ts';
import type { Config } from '../config.ts';
import { git, headSha } from '../git.ts';
import { acquireLock } from '../cli.ts';
import { protectedShaKey } from '../core/guard.ts';

export function slugify(title: string): string {
  if (!title) {
    return 'goal';
  }

  const normalized = title
    .replace(/[đĐ]/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const truncated = normalized.slice(0, 30).replace(/-+$/, '');
  return truncated || 'goal';
}

export function goalBranch(n: number, title: string): string {
  return `goal/G${n}-${slugify(title)}`;
}

export function readProjectKey(repo: string): string {
  const projectYamlPath = join(repo, 'team', 'project.yaml');
  if (!existsSync(projectYamlPath)) {
    throw new Error(`Project configuration file not found: "${projectYamlPath}"`);
  }

  let content: string;
  try {
    content = readFileSync(projectYamlPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read project configuration "${projectYamlPath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new Error(`Invalid YAML in "${projectYamlPath}": ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid project configuration in "${projectYamlPath}": expected an object`);
  }

  const key = (parsed as { key?: unknown }).key;
  if (typeof key !== 'string' || !/^[A-Z]{2,5}$/.test(key)) {
    throw new Error(
      `Invalid or missing project key in "${projectYamlPath}". Expected key matching /^[A-Z]{2,5}$/, got "${key}"`
    );
  }

  return key;
}

export type ApproveGoalResult =
  | { ok: true; sha: string }
  | { ok: false; code: 'not_ready' | 'busy' | 'conflict' | 'dirty'; message: string };

export function approveGoal(
  store: Store,
  repo: string,
  cfg: Config,
  n: number,
  by = 'owner'
): ApproveGoalResult {
  const releaseLock = acquireLock(cfg.host.data_dir);
  if (!releaseLock) {
    return {
      ok: false,
      code: 'busy',
      message: 'Another operation or session is running (lock held)',
    };
  }

  try {
    const goal = store.getGoal(repo, n);
    if (!goal) {
      return {
        ok: false,
        code: 'not_ready',
        message: `Goal G${n} not found`,
      };
    }

    const auditAgent = (effectiveSeats(cfg, store, repo).audit || cfg.seats?.audit || '').trim();
    const hasAudit = auditAgent.length > 0;
    const isReady = hasAudit
      ? goal.state === 'audit_passed'
      : (goal.state === 'qc_done' || goal.state === 'audit_passed');

    if (!isReady) {
      return {
        ok: false,
        code: 'not_ready',
        message: `Goal G${n} is in state "${goal.state}", expected ${hasAudit ? '"audit_passed"' : '"qc_done" or "audit_passed"'}`,
      };
    }

    if (!goal.reviewed_sha?.trim()) {
      return {
        ok: false,
        code: 'not_ready',
        message: 'goal chưa có commit đã QC/audit',
      };
    }

    const dirtyCheck = git(repo, 'status', '--porcelain').trim();
    if (dirtyCheck.length > 0) {
      return {
        ok: false,
        code: 'dirty',
        message: 'Working tree is dirty',
      };
    }

    const currentBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    const originalRef = currentBranch === 'HEAD' ? headSha(repo) : currentBranch;
    const previousState = goal.state;
    const protectedBranch = cfg.git?.protected_branch || 'main';
    const protectedRef = protectedBranch.startsWith('refs/heads/')
      ? protectedBranch
      : `refs/heads/${protectedBranch}`;
    const goalRef = goal.branch.startsWith('refs/heads/')
      ? goal.branch
      : `refs/heads/${goal.branch}`;

    const pinKey = protectedShaKey(repo);
    const pinnedSha = store.getSetting(pinKey)?.trim() || '';
    let currentProtectedSha = '';
    try {
      currentProtectedSha = git(repo, 'rev-parse', protectedRef).trim();
    } catch {}

    // Main đổi ngoài BTM (anh tự merge/pull): không tự kéo về – có thể xoá việc của anh. Anh chạy `btm main accept`.
    if (pinnedSha && currentProtectedSha !== pinnedSha) {
      return {
        ok: false,
        code: 'not_ready',
        message: 'protected_branch_moved',
      };
    }

    if (!pinnedSha && currentProtectedSha) {
      store.setSetting(pinKey, currentProtectedSha);
    }

    let branchSha = '';
    try {
      branchSha = git(repo, 'rev-parse', goalRef).trim();
    } catch {
      return {
        ok: false,
        code: 'not_ready',
        message: `Goal branch "${goalRef}" not found`,
      };
    }

    if (branchSha !== goal.reviewed_sha) {
      return {
        ok: false,
        code: 'not_ready',
        message: 'nhánh goal đã đổi sau khi QC/audit',
      };
    }

    // C4: Goal có commit G<n>: cmd ngoài dải ticket → yêu cầu goal có audit (state === 'audit_passed')
    try {
      const logOut = git(repo, 'log', '--format=%H%x00%s', `${protectedRef}..${goal.reviewed_sha}`).trim();
      if (logOut) {
        const commits = logOut
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const idx = line.indexOf('\0');
            return idx >= 0
              ? { sha: line.slice(0, idx).trim(), subject: line.slice(idx + 1).trim() }
              : { sha: line.trim(), subject: '' };
          });
        const cmdRegex = new RegExp(`^G(?:${n}|\\d+):\\s*cmd\\b`);
        const cmdCommits = commits.filter((c) => cmdRegex.test(c.subject));
        if (cmdCommits.length > 0) {
          const coveredShas = new Set<string>();
          const tickets = store.listTickets(repo, `G${n}`);
          for (const t of tickets) {
            if (!t.base_sha) continue;
            const latestTicketCommit = commits.find((c) => c.subject.startsWith(`${t.id}:`));
            if (!latestTicketCommit) continue;
            try {
              const rangeOut = git(repo, 'log', '--format=%H', `${t.base_sha}..${latestTicketCommit.sha}`).trim();
              if (rangeOut) {
                for (const sha of rangeOut.split(/\r?\n/)) {
                  if (sha.trim()) coveredShas.add(sha.trim());
                }
              }
            } catch {}
          }
          const hasUnreviewedCmd = cmdCommits.some((c) => !coveredShas.has(c.sha));
          if (hasUnreviewedCmd && goal.state !== 'audit_passed') {
            return {
              ok: false,
              code: 'not_ready',
              message: 'có commit lệnh trực tiếp chưa review',
            };
          }
        }
      }
    } catch {
      return {
        ok: false,
        code: 'not_ready',
        message: 'không thể kiểm tra commit lệnh trực tiếp',
      };
    }

    const mergeTarget = goal.reviewed_sha;
    store.setGoalState(repo, n, 'approved', by, 'owner approved');

    let mergeSha: string;
    try {
      git(repo, 'checkout', protectedBranch);
      const headRef = git(repo, 'symbolic-ref', 'HEAD').trim();
      if (headRef !== protectedRef) {
        throw new Error(`Checkout failed: HEAD is ${headRef}, expected ${protectedRef}`);
      }
      git(
        repo,
        '-c',
        `user.name=${by}`,
        '-c',
        `user.email=${by}@btm.local`,
        'merge',
        '--no-ff',
        mergeTarget,
        '-m',
        `G${n}: ${goal.title}`
      );
      mergeSha = headSha(repo);
      store.setSetting(pinKey, mergeSha);
    } catch (err: any) {
      try {
        git(repo, 'merge', '--abort');
      } catch {}
      try {
        git(repo, 'checkout', originalRef);
      } catch {}
      store.setGoalState(repo, n, previousState, by, `merge conflict: ${err?.message || String(err)}`);
      return {
        ok: false,
        code: 'conflict',
        message: err?.message || String(err),
      };
    }

    store.setGoalState(repo, n, 'merged', by, 'merged');

    try {
      git(repo, 'checkout', originalRef);
    } catch {}

    return {
      ok: true,
      sha: mergeSha,
    };
  } finally {
    releaseLock();
  }
}
