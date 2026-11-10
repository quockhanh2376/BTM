# P4-FIX-C · Qeen · Review lệnh trực tiếp qua guard

Đọc: team/prompts/P4-FIXC-victor.md, team/reports/P4-FIXC-dev.md, src/core/guard.ts, src/server/host.ts (`processQueue`).

**Kiểm:**
1. Tách guard sang src/core/guard.ts không đổi hành vi session (so với bản trước trong `git diff`).
2. Lệnh trực tiếp dev/qc: chỉ chạy trên nhánh goal; main/nhánh khác/tree bẩn → từ chối, item cancelled, không commit gì.
3. Mọi nhánh kết thúc lượt (ok/timeout/lỗi/abort/throw) đều gọi guardAgentTurn; agent commit lên main → main được khôi phục.
4. Commit của Core bắt đầu `G<n>: cmd <id>:`; qc trực tiếp không để lại thay đổi.
5. Thay đổi tests/init.test.ts (thêm checkout nhánh goal) là hợp lý; không test nào bị xoá.
6. `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.

Ghi chú Cheki: Ubuntu 657/657 ×3.
**Báo cáo:** team/reports/P4-FIXC-qeen.md
