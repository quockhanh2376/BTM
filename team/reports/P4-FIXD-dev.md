# Báo cáo P4-FIX-D: Bảo vệ main chống agent cố tình (B1, B2, B3, B7)
- B1: Dùng ref đầy đủ `refs/heads/<name>` trong guard, approveGoal, migrate, session; kiểm `symbolic-ref HEAD` sau checkout.
- B2: Thêm cột `reviewed_sha` vào bảng `goals`; ghi nhận khi goal chuyển `qc_done` (không audit) hoặc `audit_passed`.
- B2: `approveGoal` từ chối `not_ready` ("nhánh goal đã đổi sau khi QC/audit") nếu head khác `reviewed_sha`; merge bằng sha.
- B2: Guard snapshot lưu sha mọi `refs/heads/goal/*`; khôi phục/xoá nhánh goal khác bị sửa/xoá/tạo mới, vi phạm `agent_modified_other_goal`.
- B3: `git()` và `commitAll()` luôn truyền `-c core.hooksPath=<tmpdir/btm-empty-hooks> -c core.fsmonitor=false` ngăn chạy hook can thiệp.
- B7: Main bị xoá được tạo lại qua `update-ref refs/heads/<protected> <protectedHead>` (`agent_modified_protected_branch`); goal bị xoá được tạo lại tại `preHead` và checkout (`agent_switched_branch`).
- `npx tsc --noEmit` exit 0.
- `npx vitest run`: 650 passed, 15 failed (đúng 15 lỗi Windows baseline, 0 lỗi trong các test guard/gate/goal/session mới).
