import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { cleanDocName, docxText, extractDoc, joinDocs, materialForPrompt, unzipEntries, xlsxText } from '../src/meeting/docs.ts';

/** Zip tối thiểu cho test (method 0 hoặc 8; CRC để 0 – trình đọc của BTM không kiểm CRC). */
export function makeZip(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const DOCX = () => makeZip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Báo cáo chi phí Q3</w:t></w:r></w:p><w:p></w:p><w:p><w:r><w:t xml:space="preserve">Tổng chi: </w:t></w:r><w:r><w:t>120 triệu &amp; tăng 8%</w:t></w:r></w:p></w:body></w:document>',
});
export const XLSX = () => makeZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Q3" sheetId="1" r:id="rId1"/><sheet name="Ghi chú" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Hạng mục</t></si><si><r><t>Chi </t></r><r><t>phí</t></r></si><si><t>Server</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>4500</v></c><c r="C2"/></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Số liệu tạm</t></is></c></row></sheetData></worksheet>',
});

describe('Tài liệu cuộc họp: rút chữ (2026-11-14)', () => {
  it('zip: đọc mục được hỏi (stored + deflate); không phải zip → lỗi', () => {
    for (const deflate of [true, false]) {
      const z = makeZip({ 'a.txt': 'xin chào', 'b/c.xml': '<x/>' }, deflate);
      const got = unzipEntries(z, (n) => n === 'a.txt');
      expect([...got.keys()]).toEqual(['a.txt']);
      expect(got.get('a.txt')!.toString('utf8')).toBe('xin chào');
    }
    expect(() => unzipEntries(Buffer.from('not a zip at all, definitely not'), () => true)).toThrow();
  });

  it('Word: mỗi đoạn có số, bỏ đoạn rỗng, giải mã &amp;', () => {
    expect(docxText(DOCX())).toBe('[đoạn 1] Báo cáo chi phí Q3\n[đoạn 2] Tổng chi: 120 triệu & tăng 8%');
  });

  it('Excel: sheet + ô, chuỗi dùng chung, chuỗi nội dòng, ô rỗng bỏ qua', () => {
    expect(xlsxText(XLSX())).toBe('## Sheet Q3\nA1: Hạng mục | B1: Chi phí\nA2: Server | B2: 4500\n## Sheet Ghi chú\nA1: Số liệu tạm');
  });

  it('extractDoc: text / docx / xlsx / pdf (pdftotext giả, theo trang); từ chối loại lạ, file rỗng, quá lớn, PDF scan, .doc cũ', async () => {
    expect(await extractDoc('ghi chú.md', Buffer.from('dòng 1\r\ndòng 2'))).toEqual({ name: 'ghi chú.md', text: 'dòng 1\ndòng 2', note: '2 lines' });
    expect((await extractDoc('a.docx', DOCX())).note).toBe('2 paragraphs');
    expect((await extractDoc('a.xlsx', XLSX())).note).toBe('2 sheets');
    const pdf = Buffer.from('%PDF-1.7 fake');
    const got = await extractDoc('BaoCao.pdf', pdf, async () => 'Trang một có chữ rõ ràng\n\fTrang hai cũng có chữ đầy đủ\n\f');
    expect(got.text).toBe('[trang 1]\nTrang một có chữ rõ ràng\n\n[trang 2]\nTrang hai cũng có chữ đầy đủ');
    expect(got.note).toBe('2 pages');
    await expect(extractDoc('scan.pdf', pdf, async () => '\f\f\f')).rejects.toThrow(/no text layer/);
    await expect(extractDoc('x.pdf', Buffer.from('hello'))).rejects.toThrow(/Not a PDF/);
    await expect(extractDoc('x.pdf', pdf, async () => { throw new Error('boom'); })).rejects.toThrow(/Could not read this PDF/);
    await expect(extractDoc('x.exe', Buffer.from('MZ'))).rejects.toThrow(/Unsupported/);
    await expect(extractDoc('old.docx', Buffer.from('\xd0\xcf\x11\xe0 old binary doc', 'latin1'))).rejects.toThrow(/save as \.docx/);
    await expect(extractDoc('e.txt', Buffer.alloc(0))).rejects.toThrow(/Empty/);
    await expect(extractDoc('big.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 97))).rejects.toThrow(/20 MB/);
    await expect(extractDoc('bin.txt', Buffer.from([65, 0, 66]))).rejects.toThrow(/Not a text file/);
    expect(cleanDocName('../../etc/pass"wd.txt')).toBe('.._.._etc_passwd.txt');
  });

  it('đưa vào prompt: vừa thì nguyên văn; dài thì chọn đoạn theo từ khoá (không dấu), giữ đầu mỗi file, trong giới hạn', () => {
    const small = joinDocs([{ name: 'a.txt', text: 'ngắn', note: '' }]);
    expect(materialForPrompt(small, 'gì đó')).toBe(small);
    const filler = Array.from({ length: 400 }, (_, i) => `Dòng thường số ${i} nói về thời tiết và du lịch.`).join('\n');
    const big = joinDocs([
      { name: 'Dai.pdf', text: `[trang 1]\nMở đầu tài liệu\n${filler}\n[trang 9]\nChi phí máy chủ tăng 40% trong quý ba.\n${filler}`, note: '' },
      { name: 'Khac.txt', text: `Đầu file khác\n${filler}`, note: '' },
    ]);
    const out = materialForPrompt(big, 'bàn về chi phi may chu', 6000, 12000);
    expect(out.length).toBeLessThanOrEqual(6000);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(12000);
    expect(out).toContain('Chi phí máy chủ tăng 40%');
    expect(out).toContain('### FILE: Dai.pdf · [trang 9]');
    expect(out).toContain('Mở đầu tài liệu');
    expect(out).toContain('Đầu file khác');
    expect(out).toMatch(/Core chỉ đưa \d+\/\d+ đoạn/);
  });
});
