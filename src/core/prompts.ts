import type { TaskCard } from '../task/card.ts';

export function pmPrompt(goals: string[]): string {
  const goalText = goals.map((g) => g.replace(/\r?\n/g, ' ')).join('; ');
  return [
    `Bạn là PM. Hãy lập các thẻ task tại team/tasks/T-xxx.md cho mục tiêu: ${goalText}`,
    `Chỉ ghi thẻ vào team/tasks/, không sửa file khác, cấm git commit và push.`,
    `Mỗi task tối đa 5 acceptance. Thẻ bắt buộc có front matter YAML hợp lệ, chuỗi có ': ' đặt trong nháy.`,
    `Định dạng thẻ: id, goal, scope (mảng), acceptance (mảng), done_when.`,
    `Scope chỉ là đường dẫn trần (file, hoặc thư mục kết thúc '/'), không chú thích.`,
    `acceptance và done_when chỉ mô tả kết quả sản phẩm kiểm tra được; KHÔNG ghi quy trình git (commit, push, git status, nhánh) vì Core tự lo.`,
  ].join('\n');
}

export function devPrompt(card: TaskCard, fixNotes: string[] = [], allow: string[] = []): string {
  const goal = card.goal.replace(/\r?\n/g, ' ').trim();
  const scope = card.scope.map((s) => s.replace(/\r?\n/g, ' ').trim()).join(', ');
  const doneWhen = card.done_when.replace(/\r?\n/g, ' ').trim();
  const cleanNotes = fixNotes.map((n) => n.replace(/\r?\n/g, ' ').trim()).join('; ');
  const notesLine = cleanNotes ? `Lưu ý cần sửa: ${cleanNotes}` : `Không có ghi chú sửa.`;
  const allowText = allow.join(', ');
  const allowLine = `Lệnh được phép: ${allowText}; mỗi lệnh chạy riêng lẻ, không nối &&/;/|, không find/sed/rm, đọc file bằng công cụ đọc file.`;
  return [
    `Bạn là Dev. Hãy đọc file team/tasks/${card.id}.md (gồm acceptance) để thực hiện task ${card.id}: ${goal}`,
    `Phạm vi cho phép: ${scope}. Nghiệm thu: ${doneWhen}`,
    notesLine,
    allowLine,
    `Chỉ sửa file trong phạm vi, cấm git commit và push. Bị nghẽn trả lời BLOCKED.`,
    `Báo cáo vào team/reports/${card.id}-dev.md theo mẫu (Bug / Cần sửa / Cần xác nhận; ổn ghi OK).`,
  ].join('\n');
}

export function qcPrompt(card: TaskCard, base: string): string {
  const goal = card.goal.replace(/\r?\n/g, ' ').trim();
  const scope = card.scope.map((s) => s.replace(/\r?\n/g, ' ').trim()).join(', ');
  const doneWhen = card.done_when.replace(/\r?\n/g, ' ').trim();
  return [
    `Bạn là QC. Hãy đọc file team/tasks/${card.id}.md (gồm acceptance) để kiểm tra task ${card.id}: ${goal}`,
    `So sánh thay đổi từ base commit ${base} đến HEAD theo acceptance và done_when.`,
    `Phạm vi kiểm tra: ${scope}. Nghiệm thu: ${doneWhen}`,
    `Core tự commit sau mỗi lượt Dev nên có commit sau base là bình thường; file trong team/reports/ luôn được phép; bỏ qua mọi tiêu chí về git/commit; chỉ chấm sản phẩm theo acceptance.`,
    `Đánh giá code và báo cáo Dev theo tiêu chuẩn nghiệm thu, cấm git commit và push.`,
    `JSON QcResult đặt cuối câu trả lời theo mẫu: {"verdict":"pass"|"fail","bugs":[],"fix":[],"confirm":[]}.`,
  ].join('\n');
}
