# P4-FIX-B · Victor · Luật ticket (review #5 #6 #7 #9 #10)

Chi tiết: team/reviews/P4-review-1.md. Viết test TRƯỚC, thấy FAIL rồi mới sửa. Giữ nguyên guardAgentTurn của FIX-A.

1. **#5 PM lỗi → không để ticket rác.** Mọi nhánh PM thất bại (timeout/lỗi/abort/pm_out_of_scope/pm_modified_existing_ticket/validation): khôi phục `team/tickets/` về đúng trạng thái trước lượt PM (xoá file mới, trả file cũ) rồi mới return `needs_owner`; KHÔNG commit file ticket của lượt hỏng; không gọi upsert/setTicketState. Kiểm `pm_modified_existing_ticket` TRƯỚC mọi commit.
2. **#9 ID liên tiếp.** Ticket mới của một lượt PM phải là đúng `nextSeq … nextSeq+N-1` (không nhảy số); sai → như #1 với note `pm_ticket_id_not_sequential`.
3. **#6 Coder toàn bộ lịch sử.** "Người đã code ticket" = mọi agent `by` của chuyển trạng thái `→ in_dev` hoặc `→ awaiting_qc` trong `store.ticketHistory` (mọi phiên), không chỉ turns của phiên hiện tại. Áp dụng cho luật QC (ticket đó) và audit (mọi ticket của goal).
4. **#7 Dev không được sửa ticket.** Gate: mọi thay đổi trong `team/tickets/` từ base..HEAD → lý do `ticket_tampered` (kể cả khi scope có liệt kê). Khi gate rớt vì `ticket_tampered`, Core khôi phục `team/tickets/` từ base và commit `<ID>: restore tickets` trước vòng sửa kế tiếp. Ticket luôn được đọc lại sau khôi phục.
5. **#10 Lệnh gate làm bẩn tree.** Sau khi chạy build/lint/test của gate, tree bẩn bởi file không bị ignore → `git clean -fd` + `git checkout -- .` các file đó rồi mới gọi QC (ghi log 1 dòng), để QC không bị `qc_modified_repo` oan.

Scope: src/core/session.ts, src/gate/gate.ts, tests/session.test.ts, tests/gate.test.ts. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: team/reports/P4-FIXB-dev.md (≤10 dòng, con số thật).
