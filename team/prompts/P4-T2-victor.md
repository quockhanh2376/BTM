# P4-T2 · Victor · Store: goals, tickets, lịch sử, bộ đếm ID

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 2** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md.
Dùng type từ src/ticket/ticket.ts (`Ticket`, `TicketState`) và `goalBranch` từ src/ticket/goal.ts (đã có ở P4-T1).

**Scope:** src/store/db.ts, tests/store.test.ts

**Làm:**
- Bảng mới trong khối `CREATE TABLE IF NOT EXISTS` sẵn có: `goals(project, n, title, state, branch, created_at, updated_at, PK(project,n))`, `tickets(project, id, goal, number, of, title, type, size, state, fix_rounds, base_sha, updated_at, PK(project,id))`, `ticket_history(id AUTOINCREMENT, project, ticket_id, from_state, to_state, by, reason, at)`, `project_counters(project PK, next_ticket_seq)`.
- Thêm vào interface `Store` + cài đặt (prepared statement như code cũ): `createGoal`, `getGoal`, `listGoals`, `setGoalState`, `upsertTicket`, `getTicketState`, `setTicketState`, `listTickets`, `ticketHistory`, `nextTicketSeq`, `bumpTicketSeq` – đúng chữ ký trong plan.
- `setTicketState` cập nhật `tickets` + ghi `ticket_history` trong **một transaction** (`db.transaction`); ticket chưa có → ném lỗi.
- `upsertTicket` không ghi đè `state`/`fix_rounds` của ticket đã có.
- Không xoá/sửa bảng cũ (`task_states`, `session_tasks`…).

**Test:** đủ case trong plan Task 2 + `upsertTicket` lần 2 giữ nguyên state.

**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).
**Báo cáo:** team/reports/P4-T2-dev.md
