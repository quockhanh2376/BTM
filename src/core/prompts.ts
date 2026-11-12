import type { Seat } from '../config.ts';
import { reportHeader, type Ticket, type AuditFinding } from '../ticket/ticket.ts';

export interface PromptNote {
  notePath?: string;
  imagePath?: string;
  id?: string;
  note?: string;
  image?: string;
}

export function directPrompt(to: Seat, text: string, allow: string[] = []): string {
  const cleanText = text.replace(/\r?\n/g, ' ').trim();
  if (to === 'dev') {
    const allowText = allow.join(', ');
    const allowLine = `Lệnh được phép: ${allowText}; mỗi lệnh riêng lẻ, không nối &&/;/|, không commit, đọc file bằng công cụ đọc file.`;
    return [
      `Bạn là Dev. Hãy thực hiện yêu cầu trực tiếp sau: ${cleanText}`,
      `Phạm vi cho phép: toàn repo trừ .git.`,
      allowLine,
      `Chỉ sửa file trong phạm vi, cấm git commit và push. Bị nghẽn trả lời BLOCKED.`,
      `Báo cáo kết quả theo mẫu (Bug / Cần sửa / Cần xác nhận; ổn ghi OK).`,
    ].join('\n');
  }
  if (to === 'qc') {
    return [
      `Bạn là QC (chỉ đọc). Hãy kiểm tra yêu cầu trực tiếp sau: ${cleanText}`,
      `Chỉ đọc, không sửa file, cấm git commit và push.`,
      `Trả lời ngắn: Bug / Cần sửa / Cần xác nhận; ổn ghi OK.`,
    ].join('\n');
  }
  if (to === 'audit') {
    return [
      `Bạn là Audit (chỉ đọc). Hãy kiểm tra yêu cầu trực tiếp sau: ${cleanText}`,
      `Chỉ đọc, không sửa file, cấm git commit và push.`,
      `Trả lời ngắn: kết quả kiểm tra bảo mật; ổn ghi OK.`,
    ].join('\n');
  }
  return cleanText;
}

export function pmTicketPrompt(
  g: { n: number; title: string },
  key: string,
  nextId: string,
  opts?: {
    notes?: Array<string | PromptNote>;
    hasOpenspec?: boolean;
    auditFindings?: AuditFinding[];
  }
): string {
  const cleanTitle = g.title.replace(/\r?\n/g, ' ').trim();
  const goalId = `G${g.n}`;
  const lines = [
    `Bạn là PM. Hãy lập các ticket tại team/tickets/<ID>.md cho mục tiêu ${goalId}: ${cleanTitle}.`,
    `Ticket ID bắt đầu từ ${nextId}, tăng dần theo toàn project, đúng KEY ${key} (dạng ${key}-nnnn).`,
    `number và of đánh số liên tục 1..N trong goal ${goalId} (number ≤ of). Mỗi file 1 ticket.`,
    `Thẻ bắt buộc có front matter YAML hợp lệ, chuỗi có ': ' đặt trong nháy.`,
    `Định dạng ticket: id, goal (${goalId}), number, of, title, type (feat|fix|chore|security), size (S|M|L), scope (mảng), acceptance (1-5 mục), done_when.`,
    `Quy định size: S hoặc M; size L phải tách nhỏ trước khi giao Dev.`,
    `Scope chỉ là đường dẫn trần (file, hoặc thư mục kết thúc '/'), không chú thích.`,
    `acceptance và done_when chỉ mô tả kết quả sản phẩm kiểm tra được; KHÔNG ghi quy trình git vì Core tự lo.`,
    `Chỉ ghi file vào team/tickets/, không sửa file khác, cấm git commit và push.`,
  ];

  if (opts?.hasOpenspec) {
    lines.push('Đề xuất thay đổi bằng OpenSpec (openspec/changes/<tên>), mỗi thẻ ghi openspec_change: <tên>.');
  }

  if (opts?.notes && opts.notes.length > 0) {
    for (const item of opts.notes) {
      if (typeof item === 'string') {
        lines.push(`Đọc ${item}.`);
      } else {
        const nPath = item.notePath ?? item.note ?? '';
        const iPath = item.imagePath ?? item.image ?? '';
        const nId = item.id ?? (nPath.match(/N-\d+/) || [])[0] ?? '';
        const parts: string[] = [];
        if (nPath) parts.push(nPath);
        if (iPath) parts.push(iPath);
        lines.push(`Đọc ghi chú ${parts.join(' và ')}. Mỗi thẻ ghi note: ${nId} trong front matter.`);
      }
    }
  }

  if (opts?.auditFindings && opts.auditFindings.length > 0) {
    const findingsList = opts.auditFindings
      .map((f) => {
        const cleanTicket = f.ticket.replace(/\r?\n/g, ' ').trim();
        const cleanText = f.text.replace(/\r?\n/g, ' ').trim();
        return `[${f.severity.toUpperCase()}] ${cleanTicket}: ${cleanText}`;
      })
      .join('; ');
    lines.push(
      `Yêu cầu sửa theo kết quả Audit: lập ticket sửa mới với from_audit: true, nhận number tiếp theo trong goal ${goalId}. Các vấn đề: ${findingsList}`
    );
  }

  return lines.join('\n');
}

export function devTicketPrompt(
  t: Ticket,
  agentName: string,
  fixNotes: string[] = [],
  allow: string[] = [],
  handoff = false
): string {
  const title = t.title.replace(/\r?\n/g, ' ').trim();
  const scope = t.scope.map((s) => s.replace(/\r?\n/g, ' ').trim()).join(', ');
  const doneWhen = t.done_when.replace(/\r?\n/g, ' ').trim();
  const cleanNotes = fixNotes.map((n) => n.replace(/\r?\n/g, ' ').trim()).join('; ');
  const notesLine = cleanNotes ? `Lưu ý cần sửa: ${cleanNotes}` : `Không có ghi chú sửa.`;
  const allowText = allow.join(', ');
  const allowLine = `Lệnh được phép: ${allowText}; mỗi lệnh chạy riêng lẻ, không nối &&/;/|, không find/sed/rm, đọc file bằng công cụ đọc file.`;
  const header = reportHeader(t, agentName, 'Dev');

  const lines = [
    `Bạn là Dev (${agentName}). Hãy đọc file team/tickets/${t.id}.md (gồm acceptance) để thực hiện ticket ${t.id}: ${title}. Tập trung: chỉ đọc ticket ${t.id} của mình, không đọc ticket khác trong team/tickets/; ticket đã đủ thông tin thì không dò repo (git log/show/grep, liệt kê thư mục) mà bắt tay sửa file ngay.`,
    `Phạm vi cho phép: ${scope}. Nghiệm thu: ${doneWhen}`,
    notesLine,
    allowLine,
    `Chỉ sửa file trong phạm vi, cấm git commit và push. Bị nghẽn trả lời BLOCKED. Sau mỗi bước ghi đè 1 dòng tiếng Anh việc đang làm vào .btm-status (không commit).`,
    `Báo cáo vào team/reports/${t.id}-dev.md: dòng đầu bắt buộc là "${header}", theo sau là tối đa 5 dòng Bug / Cần sửa / Cần xác nhận (câu hỏi cho anh Zon, kết thúc bằng ?), ổn ghi OK.`,
  ];

  if (t.note) {
    const noteId = t.note.replace(/^team\/inbox\//, '').replace(/\.md$/, '');
    lines.splice(2, 0, `Đọc team/inbox/${noteId}.md và ảnh đính kèm; làm/chấm theo ảnh.`);
  }

  if (handoff) {
    lines.push(`Bàn giao: đọc git log nhánh phiên và team/reports/${t.id}-dev.md trước khi sửa`);
  }

  return lines.join('\n');
}

export function qcTicketPrompt(t: Ticket, base: string, agentName: string): string {
  const title = t.title.replace(/\r?\n/g, ' ').trim();
  const scope = t.scope.map((s) => s.replace(/\r?\n/g, ' ').trim()).join(', ');
  const doneWhen = t.done_when.replace(/\r?\n/g, ' ').trim();
  const header = reportHeader(t, agentName, 'QC');

  const lines = [
    `Bạn là QC (${agentName}). Hãy đọc file team/tickets/${t.id}.md (gồm acceptance) để kiểm tra ticket ${t.id}: ${title}`,
    `So sánh thay đổi từ base commit ${base} đến HEAD theo acceptance và done_when.`,
    `Phạm vi kiểm tra: ${scope}. Nghiệm thu: ${doneWhen}`,
    `Core tự commit sau mỗi lượt Dev nên có commit sau base là bình thường; file trong team/reports/ luôn được phép; bỏ qua mọi tiêu chí về git/commit; chỉ chấm sản phẩm theo acceptance.`,
    `Đánh giá code và báo cáo Dev theo tiêu chuẩn nghiệm thu, cấm git commit và push.`,
    `JSON QcResult đặt trong khối \`\`\`json ở cuối câu trả lời theo mẫu: \`\`\`json {"verdict":"pass"|"fail","ticket":"${t.id}","goal":"${t.goal}","number":${t.number},"bugs":[],"fix":[],"confirm":[]} \`\`\`; kết thúc bằng báo cáo: dòng đầu bắt buộc là "${header}", theo sau là tối đa 5 dòng Bug / Cần sửa / Cần xác nhận, ổn ghi OK.`,
  ];

  if (t.note) {
    const noteId = t.note.replace(/^team\/inbox\//, '').replace(/\.md$/, '');
    lines.splice(3, 0, `Đọc team/inbox/${noteId}.md và ảnh đính kèm; làm/chấm theo ảnh.`);
  }

  return lines.join('\n');
}

export function auditPrompt(
  goal: { n: number; title: string },
  base: string,
  ticketIds: string[],
  agentName: string
): string {
  const goalId = `G${goal.n}`;
  const cleanTitle = goal.title.replace(/\r?\n/g, ' ').trim();
  const ticketsStr = ticketIds.join(', ');

  const lines = [
    `Bạn là Audit (${agentName}). Hãy kiểm tra bảo mật toàn bộ thay đổi của mục tiêu ${goalId} (${cleanTitle}) từ commit base ${base} đến HEAD.`,
    `Các ticket đã hoàn thành trong mục tiêu: ${ticketsStr}.`,
    `Checklist kiểm tra: lộ secret/token, injection (SQL/command/path), xác thực & phân quyền, upload/đường dẫn file, dependency mới, log lộ dữ liệu nhạy cảm.`,
    `Bạn là vai trò CHỈ ĐỌC: không sửa file, không ghi file, cấm git commit và push. Core sẽ tự ghi báo cáo team/reports/${goalId}-audit.md từ câu trả lời của bạn.`,
    `Trả về khối JSON ở cuối câu trả lời theo định dạng:`,
    '```json',
    '{"verdict": "pass"|"fail", "findings": [{"ticket": "ID", "severity": "high"|"medium"|"low", "text": "chi tiết"}]}',
    '```',
    `Nếu có lỗi mức high hoặc medium, verdict bắt buộc là fail. Nếu không có vấn đề, findings là mảng rỗng [] và verdict là pass.`,
  ];

  return lines.join('\n');
}

