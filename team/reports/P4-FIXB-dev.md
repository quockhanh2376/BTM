# Báo cáo P4-FIX-B: Luật ticket (review #5 #6 #7 #9 #10)
- #5: PM thất bại (timeout/lỗi/abort/out_of_scope/sửa vé cũ/validation) dọn sạch team/tickets/ & working tree, không commit ticket hỏng, không tăng seq.
- #9: Kiểm tra ticket ID tuần tự (nextSeq..nextSeq+N-1); vi phạm tự dọn vé và trả needs_owner (pm_ticket_id_not_sequential).
- #6: Coder được tra cứu xuyên suốt toàn bộ store.ticketHistory (mọi session) cho cả QC (coder_cannot_qc_same_task) và Audit (auditor_is_coder).
- #7: Gate phát hiện sửa team/tickets/ (ticket_tampered); Core tự động restore team/tickets/ từ base và commit trước vòng fix kế tiếp.
- #10: Gate tự động dọn cây làm việc bị bẩn do test/build/lint (git checkout + git clean -fd) trước khi gọi QC.
- `npx tsc --noEmit` exit 0.
- `npx vitest run`: 638 passed, 15 failed (đúng 15 lỗi Windows baseline, 0 lỗi trong session.test.ts và gate.test.ts).
