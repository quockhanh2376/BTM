# P4-T1 · Victor · Ticket schema, loader, Definition of Ready

Nhánh: plan4-tickets. Đọc trước: docs/tickets.md (§3, §7) và **Task 1** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md (interfaces + test ở đó là yêu cầu chính xác).

**Scope:** src/ticket/ticket.ts, src/ticket/goal.ts (chỉ `slugify`, `goalBranch`), tests/ticket.test.ts
**Không đụng:** src/task/card.ts (xoá ở Task 6), mọi file khác.

Làm theo TDD: viết tests/ticket.test.ts đủ các case trong plan → `npx vitest run` thấy fail → code → pass.
Tái dùng luật scope (ScopePathSchema) của src/task/card.ts bằng cách copy sang ticket.ts (card.ts sẽ bị xoá).
Bỏ qua case `git check-ref-format` (lệnh git đó bị chặn với bạn); Cheki tự kiểm.

**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 fail Windows sẵn có).
**Báo cáo:** team/reports/P4-T1-dev.md
