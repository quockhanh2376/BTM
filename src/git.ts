import { execFileSync } from 'node:child_process';

export function git(repo: string, ...args: string[]): string {
  const out = execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out;
}

export function headSha(repo: string): string {
  return git(repo, 'rev-parse', 'HEAD').trim();
}

export function commitAll(
  repo: string,
  message: string,
  author: { name: string; email: string }
): string | null {
  git(repo, 'add', '-A');
  const status = git(repo, 'status', '--porcelain');
  if (!status.trim()) {
    return null;
  }
  const authorString = `${author.name} <${author.email}>`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  execFileSync(
    'git',
    [
      '-c',
      `user.name=${author.name}`,
      '-c',
      `user.email=${author.email}`,
      'commit',
      `--author=${authorString}`,
      '-m',
      message,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }
  );
  return headSha(repo);
}

export function changedFiles(repo: string, base: string): string[] {
  const out = git(repo, 'diff', '--name-status', '-M', '-z', `${base}..HEAD`);
  if (!out) {
    return [];
  }
  const files: string[] = [];
  const tokens = out.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) {
      i++;
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath) files.push(oldPath);
      if (newPath) files.push(newPath);
      i += 3;
    } else {
      const p = tokens[i + 1];
      if (p) files.push(p);
      i += 2;
    }
  }
  return Array.from(new Set(files));
}
