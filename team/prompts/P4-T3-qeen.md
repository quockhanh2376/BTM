# P4-T3 · Qeen · Review init với KEY

Đọc: Task 3 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T3-victor.md, team/reports/P4-T3-dev.md.

**Kiểm:**
1. `git status --short`: chỉ file trong scope prompt Victor (+ báo cáo).
2. KEY sai (`gtm`, `TOOLONG`, `G`, rỗng, có ký tự lạ) → ném/exit 1 và **không** tạo thư mục project.
3. Project mới có `team/project.yaml` (`key: GTM`), `team/tickets/`, `team/goals/`, không có `team/tasks/`; OpenSpec vẫn chạy như P3-T6.
4. `readProjectKey`: thiếu file, YAML hỏng, key sai định dạng → ném.
5. Test cũ vẫn kiểm đúng ý cũ (không bị xoá cho pass). `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).

**Báo cáo:** team/reports/P4-T3-qeen.md
