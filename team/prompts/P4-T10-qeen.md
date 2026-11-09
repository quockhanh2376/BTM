# P4-T10 · Qeen · Review btm migrate

Đọc: Task 10 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T10-victor.md, team/reports/P4-T10-dev.md.

**Kiểm:**
1. `git status --short`: chỉ file trong scope; không có test bị xoá.
2. Chạy 2 lần → lần 2 `already`, không commit thêm; KEY khác → lỗi, không đổi gì.
3. Tree bẩn / đang có phiên / KEY sai → không đổi gì, main không có commit mới.
4. Sau khi chạy (ok hoặc lỗi) nhánh hiện tại vẫn là nhánh cũ; nhánh session/* không đổi; team/tasks/ còn nguyên.
5. Khoá luôn được nhả. Git gọi bằng mảng tham số.
6. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).

**Báo cáo:** team/reports/P4-T10-qeen.md
