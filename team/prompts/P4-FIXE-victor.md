# P4-FIX-E · Victor · Luồng phiên còn hở (review 2: B4 B5 B6 B8 B9 + approve thiếu sha)

Chi tiết: team/reviews/P4-review-2.md. Viết test TRƯỚC (thấy FAIL) rồi sửa. Giữ nguyên guard của FIX-D.

1. **Approve thiếu sha.** `approveGoal` (src/ticket/goal.ts): `reviewed_sha` rỗng → từ chối `not_ready`, message "goal chưa có commit đã QC/audit"; không bao giờ merge theo tên nhánh.
2. **B4 – lệnh trực tiếp khi ticket đang làm.** host.ts `processQueue`: goal của nhánh hiện tại có ticket ở `in_dev`/`returned`/`awaiting_qc` → từ chối lệnh dev, item cancelled, lý do `direct_cmd_ticket_in_progress`. (Lệnh qc trực tiếp vẫn được – qc không commit.)
3. **B5 – Dev trả BLOCKED.** Trước khi commit thay đổi của lượt BLOCKED: nếu có thay đổi trong `team/tickets/` → khôi phục từ base như `ticket_tampered` (không commit sửa ticket); phần còn lại commit `<ID>: blocked`.
4. **B6 – process chết giữa lượt.** `snapshotTurn` lưu snapshot vào store (setting `turn_guard:<project>` JSON) trước lượt, xoá sau khi guard chạy xong. Đầu `runSession`/`resumeSession` và khi host khởi động (`processQueue` lần đầu): có snapshot tồn đọng → chạy `guardAgentTurn` với snapshot đó (seat ghi trong snapshot), xoá snapshot, trả `needs_owner` note `recovered_interrupted_turn` (session) / log 1 dòng (host).
5. **B8 – PM ghi ticket goal khác.** Mọi file ticket MỚI của lượt PM phải có `goal` = goal hiện tại và ID trong dải nextSeq..; sai → dọn như PM thất bại, `needs_owner` note `pm_ticket_wrong_goal`.
6. **B9 – chạy lại goal đã xong.** `runSession` với goal `approved`/`merged` → từ chối `needs_owner` note `goal_already_merged`, không đổi state.

Scope: src/core/session.ts, src/core/guard.ts, src/server/host.ts, src/ticket/goal.ts, tests liên quan. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: team/reports/P4-FIXE-dev.md (≤10 dòng, con số thật).
