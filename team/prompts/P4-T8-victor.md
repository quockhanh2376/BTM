# P4-T8 · Victor · Anh Zon duyệt & merge goal

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 8** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md.

**Scope:** src/ticket/goal.ts, src/cli.ts, tests/goal.test.ts (mới), tests/init.test.ts

**Quyết định đã chốt:**
- `approveGoal(store, repo, cfg, n, by = 'owner')` trong goal.ts; lấy khoá bằng `acquireLock(cfg.host.data_dir)` (src/cli.ts) – không lấy được → `busy`; luôn nhả khoá trong `finally`.
- Điều kiện: goal tồn tại; state `qc_done` khi KHÔNG có `seats.audit`, hoặc `audit_passed` (có hay không có audit đều nhận); working tree sạch (`dirty`); sai → `not_ready` kèm state hiện tại.
- Thứ tự: nhớ nhánh hiện tại → `setGoalState(approved, by)` → checkout `cfg.git.protected_branch` → `git merge --no-ff <goal.branch> -m "G<n>: <tiêu đề>"` → `setGoalState(merged, by)` → checkout lại nhánh cũ. Conflict/lỗi merge → `git merge --abort`, checkout lại nhánh cũ, goal về state trước đó, `conflict`.
- Không push, không xoá nhánh goal.
- CLI: `btm goal list` in bảng `G<n> · <state> · <passed>/<total> · <branch>` cho project active; `btm goal approve G<n>` → in kết quả, exit 0 khi ok, 1 khi lỗi.

**Test:** đủ case Task 8 + `busy` (khoá đang giữ), `dirty`, nhánh hiện tại được trả lại sau cả ok lẫn conflict.
**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows); không giảm số test.
**Báo cáo:** team/reports/P4-T8-dev.md
