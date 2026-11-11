import { gitBuffer } from '../git.ts';

// Plan 6 Task 3: diff ticket (base..nhánh goal) trong checkout tin cậy để anh xem và ghi chú từng dòng.
// --no-ext-diff/--no-textconv: không chạy driver diff mà .gitattributes của agent có thể khai báo.

export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
  newLine?: number;
  oldLine?: number;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  path: string;
  binary?: boolean;
  hunks: DiffHunk[];
}
export interface TicketDiff {
  files: DiffFile[];
  truncated: boolean;
}

export const MAX_DIFF_BYTES = 400 * 1024;
export const MAX_DIFF_LINES = 2000;

const SHA_RE = /^[0-9a-f]{7,64}$/;

export function parseUnifiedDiff(text: string, maxLines = MAX_DIFF_LINES): TicketDiff {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let count = 0;
  let truncated = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = { path: '', hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      if (p !== '/dev/null') file.path = p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = raw.slice(4);
      if (!file.path && p !== '/dev/null') file.path = p.replace(/^a\//, '');
      continue;
    }
    if (raw.startsWith('Binary files ')) {
      file.binary = true;
      const m = / and (?:b\/)?(.+) differ$/.exec(raw);
      if (m && m[1] !== '/dev/null' && !file.path) file.path = m[1]!;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      oldNo = +h[1]!;
      newNo = +h[2]!;
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (count >= maxLines) {
      truncated = true;
      break;
    }
    const kind = raw[0];
    if (kind === '+') hunk.lines.push({ kind: '+', text: raw.slice(1), newLine: newNo++ });
    else if (kind === '-') hunk.lines.push({ kind: '-', text: raw.slice(1), oldLine: oldNo++ });
    else if (kind === ' ') hunk.lines.push({ kind: ' ', text: raw.slice(1), oldLine: oldNo++, newLine: newNo++ });
    else continue; // "\ No newline at end of file"
    count++;
  }
  return { files, truncated };
}

export function ticketDiff(repo: string, base: string, branch: string): TicketDiff {
  if (!SHA_RE.test(base)) throw new Error('bad base');
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) throw new Error('bad branch');
  const buf = gitBuffer(repo, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '-U3', `${base}..refs/heads/${branch}`, '--');
  const truncatedBytes = buf.length > MAX_DIFF_BYTES;
  const text = buf.subarray(0, MAX_DIFF_BYTES).toString('utf8');
  const d = parseUnifiedDiff(text);
  return { files: d.files, truncated: d.truncated || truncatedBytes };
}
