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
  if (to === 'pm') {
    // Anh Zon hỏi PM (2026-11-14): chỉ đọc, trả lời từ những gì team đã làm.
    return [
      `Bạn là PM (chỉ đọc). Anh Zon hỏi: ${cleanText}`,
      `Đọc team/goals/, team/tickets/, team/reports/ và lịch sử git để trả lời. Chỉ đọc, không sửa file, cấm git commit và push.`,
      `Trả lời ngắn gọn bằng tiếng Việt, dựa trên bằng chứng (ghi ticket/file nếu có); điều không chắc thì nói rõ là chưa kiểm được.`,
    ].join('\n');
  }
  return cleanText;
}

// Chat Auto (anh Zon 2026-11-14): câu hỏi / bàn kế hoạch gửi một người trong team, CHỈ ĐỌC.
const ROLE_NAME: Record<string, string> = { pm: 'PM', dev: 'Dev', qc: 'QC', audit: 'Audit' };
export function askPrompt(seat: Seat, text: string): string {
  const cleanText = text.replace(/\r?\n/g, ' ').trim();
  const plan = /\[plan\]/i.test(cleanText);
  const question = cleanText.replace(/\[plan\]\s*/i, '');
  return [
    `Bạn là ${ROLE_NAME[seat] ?? seat} trong team BTM (chỉ đọc). Anh Zon ${plan ? 'muốn bàn kế hoạch' : 'hỏi'}: ${question}`,
    `Đọc team/goals/, team/tickets/, team/reports/, README/CHANGELOG và lịch sử git để trả lời. Chỉ đọc, không sửa hay tạo file, không chạy lệnh làm thay đổi repo, cấm git commit và push.`,
    plan
      ? `Đề xuất 2–3 job kế tiếp, mỗi job một dòng: mục tiêu, lý do, ước số ticket (S/M). Không tự tạo goal; anh Zon sẽ chọn.`
      : `Trả lời ngắn gọn bằng tiếng Việt, dẫn ticket/file làm bằng chứng; điều chưa kiểm được thì nói rõ. Không bao giờ nói anh Zon đã kiểm.`,
  ].join('\n');
}

export function pmTicketPrompt(
  g: { n: number; title: string },
  key: string,
  nextId: string,
  opts?: {
    notes?: Array<string | PromptNote>;
    hasOpenspec?: boolean;
    auditFindings?: AuditFinding[];
    docsTicket?: boolean;
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
    `Quy định size: ưu tiên S (1-3 file, Dev làm xong trong 1 lượt); M chỉ khi không tách được; size L phải tách nhỏ trước khi giao Dev.`,
    `Scope chỉ là đường dẫn trần (file, hoặc thư mục kết thúc '/'), không chú thích.`,
    `acceptance và done_when chỉ mô tả kết quả sản phẩm kiểm tra được; KHÔNG ghi quy trình git vì Core tự lo.`,
    `Chỉ ghi file vào team/tickets/, không sửa file khác, cấm git commit và push.`,
  ];

  if (opts?.docsTicket) {
    lines.push(`Ticket cuối cùng (number = of) luôn là ticket tài liệu: type chore, scope [README.md, CHANGELOG.md, package.json]; README ghi cách cài, chạy, test trên Windows; CHANGELOG thêm mục cho ${goalId}; package.json có "version" dạng x.y.z (bản đầu 1.0.0). Ticket này có depends_on là mọi ticket khác của goal.`);
  }

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
  const allowLine = `Lệnh được phép: ${allowText}; mỗi lệnh chạy riêng lẻ, không nối &&/;/|, không find/sed/rm, đọc file bằng công cụ đọc file. Không chạy code viết thẳng trên dòng lệnh (node -e, node -p, node --input-type): agy chặn và cả lượt bị bỏ; muốn thử nhanh thì viết file test rồi chạy npm test.`;
  const header = reportHeader(t, agentName, 'Dev');

  const lines = [
    `Bạn là Dev (${agentName}). Hãy đọc file team/tickets/${t.id}.md (gồm acceptance) để thực hiện ticket ${t.id}: ${title}. Tập trung: chỉ đọc ticket ${t.id} của mình, không đọc ticket khác trong team/tickets/; ticket đã đủ thông tin thì không dò repo (git log/show/grep, liệt kê thư mục) mà bắt tay sửa file ngay.`,
    `Phạm vi cho phép: ${scope}. Nghiệm thu: ${doneWhen}`,
    notesLine,
    allowLine,
    `Chỉ sửa file trong phạm vi, cấm git commit và push. Bị nghẽn trả lời BLOCKED. Chỉ khi chuyển sang phần việc mới (đọc ticket, sửa code, chạy test, viết báo cáo) thì ghi đè 1 dòng tiếng Anh vào .btm-status (không commit); không ghi sau mỗi bước. Chạy npm test tối đa 2 lần: một lần sau khi sửa xong, một lần sau khi sửa lỗi test; không chạy lại khi chưa sửa gì.`,
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

// Anh Zon 2026-11-14: "Để Finn trả lời" – PM trả lời câu hỏi đang mở thay anh, chỉ đọc, trung thực.
export function pmAnswerPrompt(questions: Array<{ id: number; ticket: string; seat: string; text: string }>, agentName: string): string {
  const list = questions
    .map((q) => `- id ${q.id} (${q.ticket}, hỏi bởi ${q.seat}): ${q.text.replace(/\r?\n/g, ' ').trim()}`)
    .join('\n');
  return [
    `Bạn là PM (${agentName}). Anh Zon giao bạn trả lời thay anh các câu hỏi Dev/QC đang hỏi. Lượt này CHỈ ĐỌC: không sửa, không tạo file, không chạy lệnh làm thay đổi repo, cấm git commit và push.`,
    `Đọc team/tickets/<ID>.md, team/reports/<ID>-*.md, team/reports/*.json và code liên quan để trả lời. Câu trả lời ngắn, rõ, dựa trên bằng chứng trong repo (ghi file/dòng nếu có).`,
    `Trung thực: chỉ trả lời điều bạn kiểm được từ repo và báo cáo. Việc phải chạy trên Windows, mở cổng mạng, bấm thử hay nhìn màn hình, hoặc cần quyết định của anh Zon thì đặt needs_owner: true và ghi lý do ngắn trong answer. Không bao giờ viết là anh Zon đã kiểm hay đã chạy.`,
    `Các câu hỏi:\n${list}`,
    `Cuối cùng in đúng một dòng JSON: {"answers":[{"id":<id>,"answer":"<trả lời>","needs_owner":<true|false>}]} gồm mọi id ở trên.`,
  ].join('\n');
}

export function qcTicketPrompt(t: Ticket, base: string, agentName: string, ownerAnswers: string[] = []): string {
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
  if (ownerAnswers.length > 0) {
    const ans = ownerAnswers.map((a) => a.replace(/\r?\n/g, ' ').trim()).join(' | ');
    lines.splice(3, 0, `Anh Zon đã chốt (đúng hơn chỗ ticket ghi "chưa chốt"): ${ans}`);
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

