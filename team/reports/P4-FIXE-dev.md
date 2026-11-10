# P4-FIXE-dev

OK

- Rà soát `git diff`: Codex đã hoàn thiện đầy đủ cả 6 mục (1: `approveGoal` bắt buộc `reviewed_sha`, 2/B4: chặn lệnh `dev` trực tiếp khi có ticket `in_dev`/`returned`/`awaiting_qc`, 3/B5: khôi phục `team/tickets/` từ `base` trước khi commit `<ID>: blocked`, 4/B6: lưu/xoá `turn_guard:<repo>` và khôi phục `recovered_interrupted_turn` ở `runSession`/`resumeSession`/`processQueue`, 5/B8: chặn `pm_ticket_wrong_goal` cho mọi ticket mới của PM ở cả lượt đầu và sau audit, 6/B9: chặn `goal_already_merged` khi `runSession` với goal `approved`/`merged`) kèm 8 test hồi quy mới trong `tests/goal.test.ts`, `tests/host.test.ts`, `tests/session.test.ts`.
- Không cần sửa thêm mục nào trong code.
- Kiểm tra cuối: `npx tsc --noEmit` sạch (exit 0); `npx vitest run`: 659 passed / 15 failed (674 tổng, đúng 15 fail Windows có sẵn).
