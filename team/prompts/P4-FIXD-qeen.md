# P4-FIX-D · Qeen · Review bảo vệ main (review 2: B1 B2 B3 B7)

Đọc: team/reviews/P4-review-2.md, team/prompts/P4-FIXD-victor.md, team/reports/P4-FIXD-dev.md, src/core/guard.ts, src/git.ts, src/ticket/goal.ts (approveGoal), src/store/db.ts (setGoalState).

**Kiểm:**
1. Mọi đọc/ghi nhánh của BTM dùng `refs/heads/…` – tìm chỗ nào còn dùng tên trần có thể bị tag che.
2. approveGoal merge đúng `reviewed_sha`; nhánh goal đổi sau QC/audit → từ chối, main không đổi.
3. Guard khôi phục nhánh goal khác bị sửa/xoá/tạo mới; không đụng nhánh của anh ngoài `goal/*` và protected.
4. Mọi lệnh git BTM tự chạy (kể cả commitAll, merge trong approve, migrate) có `core.hooksPath` rỗng + `core.fsmonitor=false`.
5. main/nhánh goal bị xoá → tạo lại, báo vi phạm, không nuốt lỗi.
6. Không test bị xoá; `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.

Ghi chú Cheki: Ubuntu 665/665 ×3. Đã biết (sẽ sửa ở FIX-E): approveGoal vẫn cho merge khi `reviewed_sha` rỗng.
**Báo cáo:** team/reports/P4-FIXD-qeen.md
