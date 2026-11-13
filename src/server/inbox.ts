import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { git, gitBuffer } from '../git.ts';

const VALID_INBOX_NAME = /^N-\d+(\.(md|png|jpg|webp))?$/;

// Ảnh kèm câu trả lời của anh Zon: nằm trong .git/btm-answers của checkout, ngoài cây làm việc, nên không bao giờ
// bị commit WIP gom vào nhánh goal (rồi push lên GitHub) hay bị git clean xoá; worker vẫn đọc được như ảnh Team note.
const VALID_ANSWER_IMAGE = /^Q-\d{1,9}\.(png|jpg|webp)$/;

export function answerImagePath(project: string, name: string): string {
  if (!VALID_ANSWER_IMAGE.test(name)) throw new Error(`Invalid answer image name: ${name}`);
  const gitDir = resolve(project, '.git');
  if (!lstatSync(gitDir).isDirectory()) throw new Error('.git must be a directory');
  const dir = resolve(gitDir, 'btm-answers');
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error('btm-answers cannot be a symlink');
  const filePath = resolve(dir, name);
  try {
    if (lstatSync(filePath).isSymbolicLink()) throw new Error(`Target file cannot be a symlink: ${filePath}`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return filePath;
}

/**
 * Returns the absolute path to an inbox note or image file inside a project.
 * Throws if the name format is invalid, if team/inbox is outside the project,
 * or if the file exists and is a symlink.
 */
export function inboxPath(project: string, name: string): string {
  if (!VALID_INBOX_NAME.test(name)) {
    throw new Error(`Invalid inbox item name: ${name}`);
  }

  const realProject = realpathSync(project);
  const teamDir = resolve(project, 'team');
  if (existsSync(teamDir)) {
    const realTeam = realpathSync(teamDir);
    const relTeam = relative(realProject, realTeam);
    if (!relTeam || relTeam.startsWith('..') || isAbsolute(relTeam)) {
      throw new Error('team/inbox must be inside project');
    }
  }

  const inboxDir = resolve(project, 'team', 'inbox');

  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
  }

  const realInbox = realpathSync(inboxDir);
  const rel = relative(realProject, realInbox);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('team/inbox must be inside project');
  }

  const filePath = resolve(inboxDir, name);
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Target file cannot be a symlink: ${filePath}`);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }

  return filePath;
}

/**
 * Reads an inbox file: working tree first, else the newest commit on any branch that has it
 * (each note is committed on its own session branch, so a cancelled note's image is not on the
 * branch currently checked out). Returns null when missing everywhere or the name is invalid.
 */
export function readInboxFile(project: string, name: string): Buffer | null {
  let filePath: string;
  try {
    filePath = inboxPath(project, name);
  } catch {
    return null;
  }
  try {
    if (lstatSync(filePath).isFile()) return readFileSync(filePath);
  } catch {}
  const rel = `team/inbox/${name}`;
  try {
    const sha = git(project, 'log', '--all', '-1', '--format=%H', '--', rel).trim();
    if (!sha) return null;
    return gitBuffer(project, 'show', `${sha}:${rel}`);
  } catch {
    return null;
  }
}

export interface DetectedImage {
  ext: 'png' | 'jpg' | 'webp';
  mime: string;
}

/**
 * Detects image format from magic bytes:
 * - PNG: 8 bytes (89 50 4E 47 0D 0A 1A 0A) -> ext 'png', mime 'image/png'
 * - JPEG: 3 bytes (FF D8 FF) -> ext 'jpg', mime 'image/jpeg' (always .jpg)
 * - WebP: RIFF....WEBP -> ext 'webp', mime 'image/webp'
 */
export function detectImage(buf: Buffer): DetectedImage | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }

  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }

  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }

  return null;
}

/**
 * Xoá file ghi chú khỏi nhánh protected (main) của checkout tin cậy, theo mẫu merge goal:
 * cây sạch, main khớp SHA ghim, checkout main, git rm, commit owner, quay lại nhánh cũ.
 * Nhánh goal/… và lịch sử git không đổi. Trả SHA main mới để ghim lại.
 */
export function removeInboxFromMain(
  repo: string,
  names: string[],
  protectedBranch: string,
  pinned: string
): { mainSha: string; removed: string[] } {
  const ref = protectedBranch.startsWith('refs/heads/') ? protectedBranch : `refs/heads/${protectedBranch}`;
  if (git(repo, 'status', '--porcelain').trim()) throw new Error('dirty');
  const before = git(repo, 'rev-parse', ref).trim();
  if (pinned && before !== pinned) throw new Error('protected_branch_moved');
  const onMain = new Set(git(repo, 'ls-tree', '-r', '--name-only', ref, '--', 'team/inbox/').split('\n'));
  const removed = names
    .filter((n) => VALID_INBOX_NAME.test(n))
    .map((n) => `team/inbox/${n}`)
    .filter((p) => onMain.has(p));
  if (removed.length === 0) return { mainSha: before, removed };
  const ids = [...new Set(removed.map((p) => /N-\d+/.exec(p)![0]))];
  const cur = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const original = cur === 'HEAD' ? git(repo, 'rev-parse', 'HEAD').trim() : cur;
  try {
    git(repo, 'checkout', '-q', ref.slice('refs/heads/'.length));
    if (git(repo, 'symbolic-ref', 'HEAD').trim() !== ref) throw new Error('checkout failed');
    git(repo, 'rm', '-q', '--', ...removed);
    git(repo, '-c', 'user.name=owner', '-c', 'user.email=owner@btm.local', 'commit', '-q', '-m', `inbox: delete ${ids.join(', ')}`);
    return { mainSha: git(repo, 'rev-parse', 'HEAD').trim(), removed };
  } catch (err) {
    try { git(repo, 'reset', '-q', '--hard'); } catch {}
    throw err;
  } finally {
    try { git(repo, 'checkout', '-q', original); } catch {}
  }
}
