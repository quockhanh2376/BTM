# Báo cáo P4-FIX-A (fix 1): An toàn git & bảo vệ protected branch
- Thêm `snapshotTurn` lưu `protectedHead`; `guardAgentTurn` gọi `git update-ref` khôi phục protected branch TRƯỚC khi checkout nhánh goal.
- Mọi ghế (pm, dev, qc, audit) commit lên protected branch đều bị khôi phục và xử lý vi phạm `agent_modified_protected_branch`.
- QC/Audit sửa protected branch: verdict fail kèm `agent_modified_protected_branch`; PM/Dev sửa: dừng `needs_owner`.
- Áp dụng đồng bộ cho mọi trường hợp: hoàn thành, timeout, lỗi, abort.
- Thêm/cập nhật tests trong `tests/session.test.ts` kiểm chứng QC, Dev và PM commit lên main.
- `npx tsc --noEmit` exit 0.
- `npx vitest run`: 631 passed, 15 failed (đúng 15 lỗi Windows baseline, 0 lỗi trong tests/session.test.ts).
