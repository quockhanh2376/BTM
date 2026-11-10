# P4-FIX-E (tiếp) · Victor · Hoàn thiện phần Codex làm dở

Đọc trước: team/prompts/P4-FIXE-victor.md (6 mục, giữ nguyên yêu cầu) + team/reviews/P4-review-2.md.

Tình trạng: Codex đã làm dở trong cây làm việc (`git diff`): test hồi quy cho cả 6 mục đã viết trong tests/goal|host|session.test.ts; code mới sửa một phần ở src/ticket/goal.ts, src/core/session.ts, src/core/guard.ts, src/server/host.ts. Codex hết hạn mức giữa chừng, chưa chạy kiểm tra cuối.

Việc của bạn:
1. Đọc `git diff`, rà phần đã sửa có đúng 6 mục không (sai thì sửa, không viết lại từ đầu).
2. Làm nốt mục còn thiếu cho tới khi test mới PASS. Không xoá/giảm test (cả test Codex mới thêm).
3. `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.

Báo cáo: team/reports/P4-FIXE-dev.md (≤10 dòng, con số thật, ghi rõ mục nào bạn sửa thêm).
