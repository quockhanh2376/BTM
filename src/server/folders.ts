import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store/db.ts';
import { gitAsync } from '../git.ts';
import { activeAccountKeys, agentOfAccount } from '../agents/accounts.ts';
import { isIsolated, workspacePath, W_GIT } from '../isolation/trusted.ts';
import { workerUser, wrapForWorker } from '../isolation/worker.ts';

// Tab Folder (anh Zon 2026-11-14): CHỈ XEM cấu trúc repo chính + thư mục làm việc của từng account.
// Chỉ tên file/thư mục, không đọc nội dung file; workspace đọc qua user worker (như mọi lệnh khác), có hạn giờ.

export const MAX_FILES = 3000;

export interface RepoFolder {
  path: string;
  branch: string | null;
  commit: { sha: string; subject: string; at: string } | null;
  dirty: number;
  files: string[];
  truncated: boolean;
}

export interface AccountFolder {
  key: string;
  agent: string;
  path: string;
  projects: string[];
  syncedAt: string | null;
  dirty: number | null;
  files: string[];
  truncated: boolean;
  error?: string;
}

export interface FoldersView {
  isolated: boolean;
  repo: RepoFolder | null;
  accounts: AccountFolder[];
}

export type ExecAsync = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultExec: ExecAsync = (file, args, timeoutMs) => new Promise((ok, fail) => {
  execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) fail(err); else ok(String(stdout));
  });
});

// Tên do agent đặt (không tin cậy): bỏ ký tự điều khiển, cắt độ dài.
function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
}

function capFiles(lines: string[]): { files: string[]; truncated: boolean } {
  const all = lines.map(cleanName).filter(Boolean);
  return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
}

async function readRepo(project: string): Promise<RepoFolder> {
  const g = (args: string[]) => gitAsync(project, args, 15_000).catch(() => '');
  const [branch, log, status, tree] = await Promise.all([
    g(['symbolic-ref', '-q', '--short', 'HEAD']),
    g(['log', '-1', '--format=%H%x00%s%x00%cI']),
    g(['status', '--porcelain']),
    g(['ls-tree', '-r', '--name-only', 'HEAD']),
  ]);
  const [sha, subject, at] = log.trim().split('\0');
  return {
    path: project,
    branch: branch.trim() || null,
    commit: sha ? { sha: sha.slice(0, 7), subject: cleanName(subject ?? ''), at: at ?? '' } : null,
    dirty: status.split('\n').filter((l) => l.trim()).length,
    ...capFiles(tree.split('\n')),
  };
}

// Một lệnh sh dưới user worker: thư mục project trong home làm việc, giờ đồng bộ (.git do BTM dựng lại mỗi lượt),
// số file đang sửa (GIT_OPTIONAL_LOCKS=0: không giữ khoá index khi agent đang chạy), danh sách file (bỏ .git, node_modules).
const WS_SCRIPT = [
  'ws=$1; dir=$2; max=$3; shift 3',
  'echo @projects; ls -1 -- "$dir" 2>/dev/null',
  'echo @synced; test -d "$ws/.git" && stat -c %Y -- "$ws/.git"',
  'echo @dirty; test -d "$ws/.git" && GIT_OPTIONAL_LOCKS=0 "$@" -C "$ws" status --porcelain 2>/dev/null | wc -l',
  'echo @files; test -d "$ws" && find "$ws" -mindepth 1 \( -name .git -o -name node_modules \) -prune -o -type f -printf "%P\n" 2>/dev/null | head -n "$max"',
  'exit 0',
].join('\n');

export function parseWorkspaceOut(out: string): Pick<AccountFolder, 'projects' | 'syncedAt' | 'dirty' | 'files' | 'truncated'> {
  const sec: Record<string, string[]> = {};
  let cur = '';
  for (const line of out.split('\n')) {
    if (/^@(projects|synced|dirty|files)$/.test(line)) { cur = line.slice(1); sec[cur] = []; continue; }
    if (cur && line !== '') sec[cur]!.push(line);
  }
  const secs = Number(sec.synced?.[0]);
  const dirty = sec.dirty?.[0] !== undefined ? Number(sec.dirty[0].trim()) : NaN;
  return {
    projects: (sec.projects ?? []).map(cleanName).slice(0, 50),
    syncedAt: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null,
    dirty: Number.isFinite(dirty) ? dirty : null,
    ...capFiles(sec.files ?? []),
  };
}

async function readAccount(cfg: Config, store: Store, key: string, project: string, exec: ExecAsync): Promise<AccountFolder> {
  const agent = agentOfAccount(cfg, store, key) ?? key;
  const ws = workspacePath(cfg, key, project);
  const dir = join(resolve(cfg.host.work_root!), workerUser(cfg, key)!);
  const base: AccountFolder = { key, agent, path: ws, projects: [], syncedAt: null, dirty: null, files: [], truncated: false };
  try {
    const argv = wrapForWorker(cfg, key, ['sh', '-c', WS_SCRIPT, 'sh', ws, dir, String(MAX_FILES + 1), ...W_GIT], dir);
    return { ...base, ...parseWorkspaceOut(await exec(argv[0]!, argv.slice(1), 15_000)) };
  } catch {
    return { ...base, error: 'not created yet or unreadable' };
  }
}

let inflight: Promise<FoldersView> | null = null;

export function readFolders(cfg: Config, store: Store, exec: ExecAsync = defaultExec): Promise<FoldersView> {
  // Nhiều tab bấm cùng lúc: dùng chung một lần đọc.
  if (inflight) return inflight;
  inflight = (async () => {
    const project = store.getActiveProject();
    const isolated = isIsolated(cfg);
    if (!project) return { isolated, repo: null, accounts: [] };
    const repo = await readRepo(project);
    const accounts = isolated
      ? await Promise.all(activeAccountKeys(cfg, store).map((k) => readAccount(cfg, store, k, project, exec)))
      : [];
    return { isolated, repo, accounts };
  })().finally(() => { inflight = null; });
  return inflight;
}

