# P4-FIX-G · Victor · Lỗ còn lại review 3 (C3–C8)

Chi tiết: team/reviews/P4-review-3.md. Viết test TRƯỚC (thấy FAIL) rồi sửa. Giữ guard FIX-D/E/F.

1. **C3** host: chặn lệnh Dev trực tiếp khi goal có ticket chưa `passed` mà có `base_sha` (gồm blocked/failed). Lý do `direct_cmd_ticket_in_progress`.
2. **C4** lệnh Dev trực tiếp đụng `team/tickets/` → khôi phục như ticket_tampered, không commit phần đó. Goal có commit `G<n>: cmd` ngoài dải ticket → approveGoal yêu cầu goal có audit (không audit → `not_ready`, message "có commit lệnh trực tiếp chưa review").
3. **C5** `resumeSession` bỏ qua/từ chối goal `approved`/`merged` như runSession (`goal_already_merged`), không đổi state.
4. **C6** host: chỉ `recoverInterruptedTurn` sau khi giữ được lock; lock ngoài (CLI `btm run`) đang giữ → không recover, không xoá snapshot.
5. **C7** nhận ticket PM: `depends_on` phải là ID có thật trong goal và số nhỏ hơn ticket đó; sai → như `pm_ticket_wrong_goal`, note `pm_ticket_bad_depends`.
6. **C8** lượt qc/audit và gate: file ignored mới xuất hiện sau lượt (so với snapshot, bỏ qua `node_modules/` có sẵn từ trước nhưng bắt file mới/đổi trong `node_modules/.bin`) → xoá + vi phạm `ignored_file_planted`.

Scope: src/server/host.ts, src/core/session.ts, src/core/guard.ts, src/ticket/goal.ts, src/ticket/ticket.ts, tests liên quan. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: team/reports/P4-FIXG-dev.md (≤10 dòng, con số thật).
