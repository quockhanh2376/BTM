# Báo cáo P4-FIX-C: Lệnh trực tiếp từ dashboard đi qua guard
- Tách `snapshotTurn`, `guardAgentTurn` và các type sang `src/core/guard.ts`; `session.ts` import lại.
- `processQueue`: kiểm tra nhánh goal (`goal/G<n>`); từ chối nếu ở main/non-goal (`direct_cmd_needs_goal_branch`, item cancelled).
- Bỏ commit `checkpoint before cmd`; từ chối nếu tree bẩn (`dirty_tree`, item cancelled).
- Dev/QC trực tiếp: snapshot trước lượt, chạy `guardAgentTurn` sau lượt ở mọi nhánh (ok/timeout/lỗi/abort/throw).
- Dev commit với prefix `G<n>: cmd <id>: …`; QC sửa file bị guard reset --hard và clean dọn sạch.
- Thêm 4 test trong `tests/host.test.ts` kiểm chứng đầy đủ các kịch bản.
- `npx tsc --noEmit` exit 0.
- `npx vitest run`: 642 passed, 15 failed (đúng 15 lỗi Windows baseline, 0 lỗi trong tests/host.test.ts).
