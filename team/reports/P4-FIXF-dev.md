# P4-FIXF-dev

OK

- Mục 1 (C2 v2): Bỏ `update-ref` trong `snapshotTurn`; khi lệch sha ghim lúc bắt đầu lượt, phiên dừng `needs_owner` kèm note `protected_branch_moved: <sha ghim> → <sha hiện tại>` và không chạy lượt. Thêm `btm main accept` trong `src/cli.ts` ghim lại sha main hiện tại và in `pin <cũ> → <mới>`. Chỉ `guardAgentTurn` (main đổi trong lượt/gate) mới khôi phục về sha snapshot.
- Mục 2 (C1 v2): Mọi lệnh git (`git()`, `gitBuffer()`, `commitAll` trong `src/git.ts` và 2 lệnh trong `src/server/inbox.ts` đã chuyển sang dùng `git()`/`gitBuffer()`) chạy với `GIT_CONFIG_GLOBAL=<file rỗng trong tmp của BTM>` và `GIT_CONFIG_NOSYSTEM=1`.
- Mục 3: Bỏ trường thừa `gitAttributes` trong `TurnGuardSnapshot` (chỉ giữ `gitInfoAttributes`).
- Test TDD (viết trước, thấy FAIL 19/683 rồi sửa PASS, giữ nguyên các test FIX-F đã thêm): cập nhật & thêm mới trong `tests/guard.test.ts`, `tests/session.test.ts`, `tests/migrate.test.ts`.
- Kiểm tra cuối: `npx tsc --noEmit` sạch (exit 0); `npx vitest run`: 668 passed / 15 failed (683 tổng, đúng 15 fail Windows có sẵn).
