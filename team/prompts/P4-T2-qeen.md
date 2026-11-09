# P4-T2 · Qeen · Review store goals/tickets

Đọc: Task 2 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T2-victor.md, team/reports/P4-T2-dev.md.

**Kiểm:**
1. `git status --short`: chỉ src/store/db.ts, tests/store.test.ts (+ báo cáo).
2. Đủ method trong plan, đúng chữ ký; bảng cũ không bị xoá/sửa.
3. Goal `n` và bộ đếm ID tách theo project; `bumpTicketSeq` không bao giờ giảm; dữ liệu còn sau khi đóng/mở lại DB.
4. `setTicketState`: cập nhật + ghi history trong 1 transaction; ticket không tồn tại → lỗi, không ghi history.
5. `upsertTicket` lần 2 không ghi đè state/fix_rounds.
6. SQL dùng tham số (không ghép chuỗi). `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).

**Báo cáo:** team/reports/P4-T2-qeen.md
