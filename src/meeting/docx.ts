// Xuất biên bản họp ra Word (.docx) (anh Zon 2026-11-14). .docx = zip gồm vài file XML; tự đóng gói bằng zlib có sẵn,
// không thêm thư viện. Nội dung lấy từ bản markdown của biên bản; mọi chữ được escape XML.
import { crc32, deflateRawSync } from 'node:zlib';
import { renderMeetingMd, type Meeting } from './core.ts';

/** Zip tối thiểu (deflate, không zip64) – đủ cho file văn bản nhỏ. */
export function zipFiles(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const packed = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // tên file UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0x00210000, 10); // giờ/ngày cố định (1980-01-01) để file xuất ra ổn định
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text: string, o: { bold?: boolean; size?: number; color?: string } = {}) =>
  `<w:r><w:rPr>${o.bold ? '<w:b/>' : ''}${o.size ? `<w:sz w:val="${o.size}"/>` : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (inner: string, o: { indent?: number; before?: number } = {}) =>
  `<w:p><w:pPr><w:spacing w:before="${o.before ?? 60}" w:after="60"/>${o.indent ? `<w:ind w:left="${o.indent}"/>` : ''}</w:pPr>${inner}</w:p>`;

/** Một dòng markdown của biên bản → đoạn Word. `**đậm**` giữ đậm. */
function line(raw: string): string {
  const bold = (text: string, size?: number, color?: string) =>
    text.split(/(\*\*.+?\*\*)/).filter(Boolean).map((part) => (/^\*\*.+\*\*$/.test(part) ? run(part.slice(2, -2), { bold: true, size, color }) : run(part, { size, color }))).join('');
  if (raw.startsWith('### ')) return para(run(raw.slice(4), { bold: true, size: 24 }), { before: 200 });
  if (raw.startsWith('## ')) return para(run(raw.slice(3), { bold: true, size: 28, color: '1F4E79' }), { before: 320 });
  if (raw.startsWith('# ')) return para(run(raw.slice(2), { bold: true, size: 36 }), { before: 0 });
  if (/^ {2}- /.test(raw)) return para(bold(raw.trim().slice(2), 18, raw.includes('✓') ? '1A7F37' : '9A6700'), { indent: 720 });
  if (raw.startsWith('- ')) return para(run('• ') + bold(raw.slice(2)), { indent: 360 });
  if (raw.startsWith('> ')) return para(bold(raw.slice(2), undefined, '0969DA'), { indent: 360 });
  return para(bold(raw));
}

export function renderMeetingDocx(m: Meeting, nameOf: (agent: string) => string = (a) => a): Buffer {
  const body = renderMeetingMd(m, nameOf).split('\n').filter((l) => l.trim()).map(line).join('');
  const xml = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`, 'utf8');
  return zipFiles([
    { name: '[Content_Types].xml', data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`) },
  ]);
}
