# P4-T3 · Victor · Init project với KEY

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 3** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md.

**Scope:** src/project/init.ts, src/cli.ts (chỉ lệnh `init`), src/ticket/goal.ts (thêm `readProjectKey`), tests/init.test.ts, tests/ticket.test.ts

**Làm:**
- `initProject(root, name, templatesFrom, opts: { key: string; runOpenspec?: RunOpenspecFn })`: key sai `/^[A-Z]{2,5}$/` → ném **trước** khi tạo thư mục. Ghi `team/project.yaml` (`key: <KEY>`), tạo `team/tickets/`, `team/goals/`; **không** tạo `team/tasks/` nữa. Giữ nguyên phần OpenSpec.
- CLI: `btm init <name> --key <KEY>`; thiếu/sai `--key` → in lỗi, exit 1, không tạo thư mục.
- `readProjectKey(repo: string): string` trong goal.ts: đọc `team/project.yaml` bằng thư viện `yaml`, ném nếu thiếu file/sai định dạng.
- Sửa các test init cũ đang gọi `initProject`/`btm init` cho có key (dùng `GTM`).

**Test:** đủ case Task 3 trong plan.
**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).
**Báo cáo:** team/reports/P4-T3-dev.md
