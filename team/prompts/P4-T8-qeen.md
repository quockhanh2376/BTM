# P4-T8 · Qeen · Review duyệt & merge goal

Đọc: Task 8 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T8-victor.md, team/reports/P4-T8-dev.md.

**Kiểm:**
1. `git status --short`: chỉ file trong scope; không có test bị xoá.
2. Goal chưa sẵn sàng / không tồn tại / tree bẩn / đang có phiên → không merge, `main` không đổi.
3. Conflict → merge --abort, main không đổi, quay về nhánh cũ, goal về state cũ.
4. Khoá luôn được nhả (kể cả khi lỗi). Không push, không xoá nhánh.
5. Tên nhánh/tiêu đề goal truyền vào git dạng mảng tham số (không ghép shell).
6. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).

**Báo cáo:** team/reports/P4-T8-qeen.md
Ghi chú Cheki: Ubuntu 630/630 ×3 lần.
