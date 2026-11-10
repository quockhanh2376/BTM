# P4-T6 · Victor · Phiên chạy theo goal + ticket

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 6** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md (bản đã sửa). Đọc thêm docs/tickets.md §2, §7. Đây là task lớn: đọc kỹ src/core/session.ts trước khi sửa, giữ nguyên mọi luật cứng đang có (giới hạn lượt, timeout, scope, coder ≠ QC, vòng sửa, abort, WIP commit, inbox note).

**Scope:** src/core/session.ts, src/core/prompts.ts, src/qc/result.ts, src/gate/gate.ts, src/cli.ts, src/server/host.ts, tests/session.test.ts, tests/host.test.ts, tests/gate.test.ts, tests/qc.test.ts, tests/init.test.ts
**Không đụng:** src/task/card.ts và src/server/snapshot.ts (Task 9 làm).

**Quyết định đã chốt (đừng tự đổi):**
- KEY lấy bằng `readProjectKey(repo)`; project = đường dẫn repo (như `active_project`).
- `runSession(d, goals: Array<string | { n: number }>)`; `sessions.goals_json` lưu mảng số goal `[1,2]`.
- `resumeSession(d, sessionId)` = chạy lại các goal của phiên đó (đọc goals_json) – ticket `passed`/`cancelled` bỏ qua.
- CLI: `btm run --goal "<tiêu đề>"` (lặp được) và `--goal-id G1` (lặp được); trộn được.
- Nhánh: mỗi goal checkout `goal/G<n>-<slug>` (tạo từ `cfg.git.protected_branch` nếu chưa có). Bỏ nhánh `session/<id>`.
- Mọi commit Core: `<ID>: …` cho ticket, `G<n>: …` cho PM/tổng kết/checkpoint của goal.
- `runGate(repo, ticket: Ticket, …)`: thêm lý do `commit_missing_ticket_id` (dùng `commitsMissingTicketId`) và `report_header_invalid` (dùng `reportHeaderOk`) khi `require_report_schema`.
- QC: `parseTicketQcResult` với `{ticket, goal, number}`.
- Sau khi chuyển xong: xoá `pmPrompt`, `devPrompt`, `qcPrompt` (prompts.ts) và `parseQcResult` (result.ts) cũ + test của chúng; bỏ import thừa `TaskCard`/`devPrompt` trong host.ts. `task_states`/`session_tasks` không ghi nữa (bảng giữ nguyên).

**Test:** đủ case Task 6 trong plan (runner giả, repo tạm). Sửa test cũ của session/host cho luồng mới; không xoá test chỉ để cho pass – test nào hết ý nghĩa (luồng T-xxx) thì thay bằng test tương đương cho ticket.

**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).
**Báo cáo:** team/reports/P4-T6-dev.md – ghi rõ nếu có chỗ phải tự quyết.
