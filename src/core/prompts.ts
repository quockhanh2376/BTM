import type { TaskCard } from '../task/card.ts';
import type { Seat } from '../config.ts';

export interface PromptNote {
  notePath?: string;
  imagePath?: string;
  id?: string;
  note?: string;
  image?: string;
}

export function pmPrompt(goals: string[], notes?: Array<string | PromptNote>): string {
  const goalText = goals.map((g) => g.replace(/\r?\n/g, ' ')).join('; ');
  const lines = [
    `Bạn là PM. Hãy lập các thẻ task tại team/tasks/T-xxx.md cho mục tiêu: ${goalText}`,
    `Chỉ ghi thẻ vào team/tasks/, không sửa file khác, cấm git commit và push.`,
    `Mỗi task tối đa 5 acceptance. Thẻ bắt buộc có front matter YAML hợp lệ, chuỗi có ': ' đặt trong nháy.`,
    `Định dạng thẻ: id, goal, scope (mảng), acceptance (mảng), done_when.`,
    `Scope chỉ là đường dẫn trần (file, hoặc thư mục kết thúc '/'), không chú thích.`,
    `acceptance và done_when chỉ mô tả kết quả sản phẩm kiểm tra được; KHÔNG ghi quy trình git (commit, push, git status, nhánh) vì Core tự lo; kết thúc bằng báo cáo ≤ 5 dòng chỉ Bug / Cần sửa / Cần xác nhận, ổn ghi OK.`,
  ];

  if (notes && notes.length > 0) {
    for (const item of notes) {
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

  return lines.join('\n');
}

export function devPrompt(card: TaskCard, fixNotes: string[] = [], allow: string[] = []): string {
  const goal = card.goal.replace(/\r?\n/g, ' ').trim();
  const scope = card.scope.map((s) => s.replace(/\r?\n/g, ' ').trim()).join(', ');
  const doneWhen = card.done_when.replace(/\r?\n/g, ' ').trim();
  const cleanNotes = fixNotes.map((n) => n.replace(/\r?\n/g, ' ').trim()).join('; ');
  const notesLine = cleanNotes ? `Lưu ý cần sửa: ${cleanNotes}` : `Không có ghi chú sửa.`;
  const allowText = allow.join(', ');
  const allowLine = `Lệnh được phép: ${allowText}; mỗi lệnh chạy riêng lẻ, không nối &&/;/|, không find/sed/rm, đọc file bằng công cụ đọc file.`;
  const lines = [
    `Bạn là Dev. Hãy đọc file team/tasks/${card.id}.md (gồm acceptance) để thực hiện task ${card.id}: ${goal}`,
    `Phạm vi cho phép: ${scope}. Nghiệm thu: ${doneWhen}`,
    notesLine,
    allowLine,
    `Chỉ sửa file trong phạm vi, cấm git commit và push. Bị nghẽn trả lời BLOCKED.`,
    `Báo cáo vào team/reports/${card.id}-dev.md kết thúc bằng báo cáo ≤ 5 dòng chỉ Bug / Cần sửa / Cần xác nhận, ổn ghi OK.`,
  ];
  if (card.note) {
    const noteId = card.note.replace(/^team\/inbox\//, '').replace(/\.md$/, '');
    lines.splice(2, 0, `Đọc team/inbox/${noteId}.md và ảnh đính kèm; làm/chấm theo ảnh.`);
  }
  return lines.join('\n');
}

export function qcPrompt(card: TaskCard, base: string): string {
  const goal = card.goal.replace(/\r?\n/g, ' ').trim();
  const scope = card.scope.map((s) => s.replace(/\r?\n/g, ' ').trim()).join(', ');
  const doneWhen = card.done_when.replace(/\r?\n/g, ' ').trim();
  const lines = [
    `Bạn là QC. Hãy đọc file team/tasks/${card.id}.md (gồm acceptance) để kiểm tra task ${card.id}: ${goal}`,
    `So sánh thay đổi từ base commit ${base} đến HEAD theo acceptance và done_when.`,
    `Phạm vi kiểm tra: ${scope}. Nghiệm thu: ${doneWhen}`,
    `Core tự commit sau mỗi lượt Dev nên có commit sau base là bình thường; file trong team/reports/ luôn được phép; bỏ qua mọi tiêu chí về git/commit; chỉ chấm sản phẩm theo acceptance.`,
    `Đánh giá code và báo cáo Dev theo tiêu chuẩn nghiệm thu, cấm git commit và push.`,
    `JSON QcResult đặt trong khối \`\`\`json ở cuối câu trả lời theo mẫu: \`\`\`json {"verdict":"pass"|"fail","bugs":[],"fix":[],"confirm":[]} \`\`\`; kết thúc bằng báo cáo ≤ 5 dòng chỉ Bug / Cần sửa / Cần xác nhận, ổn ghi OK.`,
  ];
  if (card.note) {
    const noteId = card.note.replace(/^team\/inbox\//, '').replace(/\.md$/, '');
    lines.splice(3, 0, `Đọc team/inbox/${noteId}.md và ảnh đính kèm; làm/chấm theo ảnh.`);
  }
  return lines.join('\n');
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
  return cleanText;
}
