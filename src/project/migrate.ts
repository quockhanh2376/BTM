import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git.ts';
import { readProjectKey } from '../ticket/goal.ts';
import { protectedShaKey } from '../core/guard.ts';
import { getOpenStores, type Store } from '../store/db.ts';

export interface MigrateProjectResult {
  ok: true;
  already: boolean;
  previousBranch: string;
}

function pinProtectedSha(
  repo: string,
  protRef: string,
  store?: Pick<Store, 'setSetting'>
): void {
  try {
    const sha = git(repo, 'rev-parse', protRef).trim();
    if (!sha) return;
    const key = protectedShaKey(repo);
    if (store) {
      store.setSetting(key, sha);
    }
    for (const s of getOpenStores()) {
      try {
        s.setSetting(key, sha);
      } catch {}
    }
  } catch {}
}

export function migrateProject(
  repo: string,
  key: string,
  protectedBranch: string,
  store?: Pick<Store, 'setSetting'>
): MigrateProjectResult {
  // 1. Validate key
  if (!key || typeof key !== 'string' || !/^[A-Z]{2,5}$/.test(key)) {
    throw new Error(`Invalid project key "${key}". Project key must match /^[A-Z]{2,5}$/`);
  }

  // 2. Validate clean working tree
  const status = git(repo, 'status', '--porcelain').trim();
  if (status.length > 0) {
    throw new Error(`Working tree is dirty in "${repo}". Commit or stash changes before migrating.`);
  }

  // 3. Remember current branch / ref
  const currentBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const originalRef =
    currentBranch === 'HEAD' ? git(repo, 'rev-parse', 'HEAD').trim() : currentBranch;
  const previousBranch = currentBranch;

  const projectYamlPath = join(repo, 'team', 'project.yaml');
  const ticketsDir = join(repo, 'team', 'tickets');
  const ticketsGitkeep = join(ticketsDir, '.gitkeep');
  const goalsDir = join(repo, 'team', 'goals');
  const goalsGitkeep = join(goalsDir, '.gitkeep');

  let checkedOutProtected = false;
  let createdProjectYaml = false;
  let createdTicketsGitkeep = false;
  let createdGoalsGitkeep = false;
  let committed = false;

  try {
    // Checkout protected branch
    git(repo, 'checkout', protectedBranch);
    checkedOutProtected = true;
    const protRef = protectedBranch.startsWith('refs/heads/') ? protectedBranch : `refs/heads/${protectedBranch}`;
    const headRef = git(repo, 'symbolic-ref', 'HEAD').trim();
    if (headRef !== protRef) {
      throw new Error(`Checkout failed: HEAD is ${headRef}, expected ${protRef}`);
    }

    // Check if project.yaml already exists on protected branch
    if (existsSync(projectYamlPath)) {
      const existingKey = readProjectKey(repo);
      if (existingKey === key) {
        pinProtectedSha(repo, protRef, store);
        // Stay on protectedBranch
        return { ok: true, already: true, previousBranch };
      }
      throw new Error(
        `Project already has key "${existingKey}", cannot migrate to "${key}"`
      );
    }

    // Create directories if needed
    mkdirSync(join(repo, 'team'), { recursive: true });
    mkdirSync(ticketsDir, { recursive: true });
    mkdirSync(goalsDir, { recursive: true });

    // Write team/project.yaml
    writeFileSync(projectYamlPath, `key: ${key}\n`, 'utf8');
    createdProjectYaml = true;

    // Create .gitkeep in team/tickets and team/goals if needed
    if (!existsSync(ticketsGitkeep)) {
      writeFileSync(ticketsGitkeep, '', 'utf8');
      createdTicketsGitkeep = true;
    }
    if (!existsSync(goalsGitkeep)) {
      writeFileSync(goalsGitkeep, '', 'utf8');
      createdGoalsGitkeep = true;
    }

    // Git add specific files (never touching team/tasks)
    git(repo, 'add', 'team/project.yaml');
    if (existsSync(ticketsGitkeep)) {
      git(repo, 'add', 'team/tickets/.gitkeep');
    }
    if (existsSync(goalsGitkeep)) {
      git(repo, 'add', 'team/goals/.gitkeep');
    }

    // Commit
    git(
      repo,
      '-c',
      'user.name=btm',
      '-c',
      'user.email=btm@btm.local',
      'commit',
      '--author=btm <btm@btm.local>',
      '-m',
      `migrate: project key ${key}`
    );
    committed = true;
    pinProtectedSha(repo, protRef, store);

    // Stay on protectedBranch
    return { ok: true, already: false, previousBranch };
  } catch (err) {
    if (checkedOutProtected && !committed) {
      if (createdProjectYaml && existsSync(projectYamlPath)) {
        try {
          rmSync(projectYamlPath, { force: true });
        } catch {}
      }
      if (createdTicketsGitkeep && existsSync(ticketsGitkeep)) {
        try {
          rmSync(ticketsGitkeep, { force: true });
        } catch {}
      }
      if (createdGoalsGitkeep && existsSync(goalsGitkeep)) {
        try {
          rmSync(goalsGitkeep, { force: true });
        } catch {}
      }
      try {
        git(repo, 'reset', '--hard', 'HEAD');
      } catch {}
      try {
        git(repo, 'clean', '-fd');
      } catch {}
      try {
        git(repo, 'checkout', originalRef);
      } catch {}
    }
    throw err;
  }
}
