# P4-FIX-E · Qeen · Review (read-only)

Đọc team/prompts/P4-FIXE-victor.md (6 mục) + `git diff` (src/core/guard.ts, session.ts, src/server/host.ts, src/ticket/goal.ts, tests).
Kiểm từng mục: code có làm đúng yêu cầu không, test có thật sự bắt lỗi (sẽ FAIL nếu bỏ phần sửa) không, có phá guard FIX-D hay xoá/giảm test cũ không.
Chú ý: B6 snapshot tồn đọng có bị chạy guard 2 lần / xoá nhầm snapshot project khác; B4 lệnh qc trực tiếp vẫn được; B5 không commit sửa ticket.
Chạy `npx tsc --noEmit`, `npx vitest run` (đúng 15 fail Windows).
Báo cáo: team/reports/P4-FIXE-qeen.md – Bug / Cần sửa / Cần xác nhận (≤10 dòng), ổn: "OK".
