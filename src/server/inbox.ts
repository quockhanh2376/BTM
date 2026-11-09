import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

const VALID_INBOX_NAME = /^N-\d+(\.(md|png|jpg|webp))?$/;

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
    const sha = execFileSync('git', ['log', '--all', '-1', '--format=%H', '--', rel], {
      cwd: project,
      encoding: 'utf8',
    }).trim();
    if (!sha) return null;
    return execFileSync('git', ['show', `${sha}:${rel}`], { cwd: project, maxBuffer: 20 * 1024 * 1024 });
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
