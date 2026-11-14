// Tài liệu upload cho cuộc họp (anh Zon 2026-11-14, bước 2): Core rút chữ từ PDF / Word / Excel / text, giữ dấu vị trí
// (trang, đoạn, sheet + ô) để agent dẫn chứng và Core kiểm lại. Agent không bao giờ mở file gốc.
// Spec: docs/superpowers/specs/2026-11-14-debate-meeting-design.md
import { execFile } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

export const DOC_MAX_BYTES = 20 * 1024 * 1024;
export const DOCS_MAX = 10;
export const DOC_TEXT_MAX = 2_000_000;
export const PROMPT_MATERIAL_CHARS = 40_000;
export const PROMPT_MATERIAL_BYTES = 90_000; // một tham số dòng lệnh Linux tối đa ~128 KB; để dư cho phần còn lại của prompt
const ENTRY_MAX = 30 * 1024 * 1024;
const EXT = /\.(pdf|docx|xlsx|txt|md|csv)$/i;

// Bỏ dấu + chữ thường để so từ khoá (bản gọn; search.ts có bản giữ độ dài).
const foldText = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase();

export interface DocText { name: string; text: string; note: string }
export type PdfToText = (file: Buffer) => Promise<string>;

/** Tên file an toàn để hiển thị / dẫn chứng (không dùng làm đường dẫn). */
export function cleanDocName(name: string): string {
  return String(name || '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f"<>|?*]/g, '').trim().slice(-120) || 'document';
}

/** Đọc zip tối thiểu (docx/xlsx): chỉ lấy các mục được hỏi; method 0 (stored) và 8 (deflate); chặn mục quá lớn. */
export function unzipEntries(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!want(name) || usize > ENTRY_MAX || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: ENTRY_MAX }));
  }
  return out;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});
const tOf = (xml: string) => [...xml.matchAll(/<(?:w:)?t(?:\s[^>]*)?>([^<]*)<\/(?:w:)?t>/g)].map((m) => unxml(m[1]!)).join('');

/** Word: mỗi đoạn không rỗng → "[đoạn N] …". */
export function docxText(buf: Buffer): string {
  const xml = unzipEntries(buf, (n) => n === 'word/document.xml').get('word/document.xml')?.toString('utf8');
  if (!xml) throw new Error('no word/document.xml');
  const lines: string[] = [];
  let n = 0;
  for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const t = tOf(m[0].replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t> </w:t>')).trim();
    if (t) lines.push(`[đoạn ${++n}] ${t}`);
  }
  return lines.join('\n');
}

/** Excel: mỗi sheet "## Sheet <tên>", mỗi hàng "A1: … | B1: …" (giá trị đã tính, không có công thức). */
export function xlsxText(buf: Buffer): string {
  const files = unzipEntries(buf, (n) => /^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(n));
  const wb = files.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new Error('no xl/workbook.xml');
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => tOf(m[1]!));
  const rels = new Map([...(files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1] ?? '';
    const target = (/\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? '').replace(/^\/?xl\//, '').replace(/^\//, '');
    return [id, `xl/${target}`] as const;
  }));
  const out: string[] = [];
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(/\bname="([^"]*)"/.exec(s[0])?.[1] ?? 'Sheet');
    const xml = files.get(rels.get(/\br:id="([^"]+)"/.exec(s[0])?.[1] ?? '') ?? '')?.toString('utf8');
    if (!xml) continue;
    out.push(`## Sheet ${name}`);
    let rows = 0;
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+\d+)"/.exec(c[1]!)?.[1];
        const type = /\bt="([^"]+)"/.exec(c[1]!)?.[1];
        const body = c[2] ?? '';
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const val = type === 's' ? shared[parseInt(v ?? '', 10)] ?? '' : type === 'inlineStr' ? tOf(body) : unxml(v ?? '');
        if (ref && val.trim()) cells.push(`${ref}: ${val.trim()}`);
      }
      if (cells.length) out.push(cells.join(' | '));
      if (++rows >= 5000) { out.push('… (sheet cắt ở 5.000 hàng)'); break; }
    }
  }
  return out.join('\n');
}

/** pdftotext (poppler-utils): đọc PDF từ stdin, ra chữ UTF-8; trang cách nhau bằng \f. */
export const pdftotext: PdfToText = (file) => new Promise((resolve, reject) => {
  const child = execFile('pdftotext', ['-layout', '-enc', 'UTF-8', '-', '-'], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  child.stdin?.on('error', () => {});
  child.stdin?.end(file);
});

function pdfPages(raw: string): { text: string; pages: number } {
  const pages = raw.split('\f').map((p) => p.replace(/[ \t]+\n/g, '\n').trim());
  while (pages.length && !pages[pages.length - 1]) pages.pop();
  return { pages: pages.length, text: pages.map((p, i) => (p ? `[trang ${i + 1}]\n${p}` : '')).filter(Boolean).join('\n\n') };
}

/** Rút chữ một file upload. Lỗi / loại không hỗ trợ → throw Error với lý do ngắn (hiện cho anh). */
export async function extractDoc(nameRaw: string, buf: Buffer, pdf: PdfToText = pdftotext): Promise<DocText> {
  const name = cleanDocName(nameRaw);
  const ext = EXT.exec(name)?.[1]?.toLowerCase();
  if (!ext) throw new Error('Unsupported file type (use PDF, .docx, .xlsx, .txt, .md, .csv)');
  if (!buf.length) throw new Error('Empty file');
  if (buf.length > DOC_MAX_BYTES) throw new Error('File is larger than 20 MB');
  let text = '';
  let note = '';
  if (ext === 'pdf') {
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Not a PDF file');
    let raw: string;
    try { raw = await pdf(buf); } catch { throw new Error('Could not read this PDF (is pdftotext installed? is the file protected?)'); }
    const p = pdfPages(raw);
    text = p.text;
    note = `${p.pages} pages`;
    if (text.replace(/\[trang \d+\]|\s/g, '').length < 20 * Math.max(1, p.pages)) throw new Error('This PDF has no text layer (scanned images) – text recognition is not supported yet');
  } else if (ext === 'docx' || ext === 'xlsx') {
    if (buf.readUInt16LE(0) !== 0x4b50) throw new Error(`Not a .${ext} file (old .doc/.xls are not supported – save as .${ext})`);
    try { text = ext === 'docx' ? docxText(buf) : xlsxText(buf); } catch { throw new Error(`Could not read this .${ext} file`); }
    note = ext === 'docx' ? `${text ? text.split('\n').length : 0} paragraphs` : `${(text.match(/^## Sheet /gm) ?? []).length} sheets`;
  } else {
    if (buf.includes(0)) throw new Error('Not a text file');
    text = buf.toString('utf8').replace(/\r\n/g, '\n');
    note = `${text.split('\n').length} lines`;
  }
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (!text) throw new Error('No text found in this file');
  if (text.length > DOC_TEXT_MAX) { text = text.slice(0, DOC_TEXT_MAX); note += ', truncated at 2,000,000 characters'; }
  return { name, text, note };
}

/** Gộp tài liệu thành một văn bản: mỗi file mở đầu bằng "## FILE: <tên>". */
export function joinDocs(docs: DocText[]): string {
  return docs.map((d) => `## FILE: ${d.name}\n${d.text}`).join('\n\n');
}

/**
 * Phần tài liệu đưa vào prompt. Vừa giới hạn → nguyên văn. Dài hơn → chia đoạn (~1.500 ký tự, theo dấu file / trang / sheet),
 * chấm điểm theo từ khoá của vấn đề (không dấu, không hoa thường), giữ đoạn đầu mỗi file + các đoạn điểm cao, theo thứ tự gốc.
 */
export function materialForPrompt(full: string, topic: string, maxChars = PROMPT_MATERIAL_CHARS, maxBytes = PROMPT_MATERIAL_BYTES): string {
  const fits = (s: string) => s.length <= maxChars && Buffer.byteLength(s, 'utf8') <= maxBytes;
  if (fits(full)) return full;
  interface Chunk { i: number; head: string; text: string; first: boolean; score: number }
  const chunks: Chunk[] = [];
  let file = '';
  let mark = '';
  let cur: string[] = [];
  let firstOfFile = true;
  const flush = () => {
    const text = cur.join('\n').trim();
    if (text) { chunks.push({ i: chunks.length, head: [file, mark].filter(Boolean).join(' · '), text, first: firstOfFile, score: 0 }); firstOfFile = false; }
    cur = [];
  };
  let size = 0;
  for (const line of full.split('\n')) {
    const isFile = line.startsWith('## FILE: ');
    const isMark = /^(\[trang \d+\]|## Sheet )/.test(line);
    if (isFile || isMark || size >= 1500) { flush(); size = 0; }
    if (isFile) { file = line.slice(3); mark = ''; firstOfFile = true; continue; }
    if (isMark) { mark = line.replace(/^## /, ''); continue; }
    cur.push(line.length > 3000 ? `${line.slice(0, 3000)}…` : line);
    size += line.length + 1;
  }
  flush();
  const terms = [...new Set(foldText(topic).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3))];
  for (const c of chunks) {
    const f = foldText(c.text);
    c.score = terms.reduce((n, t) => n + (f.includes(t) ? 1 : 0), 0) + (c.first ? 1000 : 0);
  }
  const picked = new Set<number>();
  let chars = 0;
  let bytes = 0;
  const cost = (c: Chunk) => `### ${c.head}\n${c.text}\n\n`;
  for (const c of [...chunks].sort((a, b) => b.score - a.score || a.i - b.i)) {
    const s = cost(c);
    const b = Buffer.byteLength(s, 'utf8');
    if (chars + s.length > maxChars - 200 || bytes + b > maxBytes - 400) continue;
    picked.add(c.i);
    chars += s.length;
    bytes += b;
  }
  const body = chunks.filter((c) => picked.has(c.i)).map(cost).join('');
  return `(Tài liệu dài: Core chỉ đưa ${picked.size}/${chunks.length} đoạn liên quan nhất tới vấn đề; phần còn lại không có ở đây.)\n\n${body}`.trim();
}
