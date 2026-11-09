# P4-T10 · Victor · `btm migrate` cho project cũ

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 10** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md.

**Scope:** src/project/migrate.ts (mới), src/cli.ts (chỉ thêm lệnh `migrate`), tests/migrate.test.ts (mới)

**Quyết định đã chốt:**
- `migrateProject(repo, key, protectedBranch)`; CLI `btm migrate --key <KEY>` chạy cho project active, lấy khoá `acquireLock(cfg.host.data_dir)` (không lấy được → lỗi "đang có phiên"), luôn nhả khoá.
- KEY hợp lệ dùng chung regex với init (`/^[A-Z]{2,5}$/`); đọc KEY đã có bằng `readProjectKey`.
- Mọi lệnh git qua helper `git()` (mảng tham số). Commit author `btm <btm@btm.local>`.
- Lỗi giữa chừng sau khi đã checkout protected branch → luôn checkout lại nhánh cũ (try/finally); không để lại file nửa vời (xoá `team/project.yaml` nếu chưa commit được).
- Không đụng team/tasks/, không merge nhánh session/*.

**Test:** đủ case Step 1 Task 10 + lỗi commit giữa chừng → nhánh cũ được trả lại, main không đổi.
**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows); không giảm số test.
**Báo cáo:** team/reports/P4-T10-dev.md
