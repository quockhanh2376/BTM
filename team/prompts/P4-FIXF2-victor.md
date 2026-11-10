# P4-FIX-F vòng 2 · Victor

Cheki kiểm FIX-F: hướng đúng, còn 3 chỗ phải sửa (test trước, giữ nguyên các test FIX-F đã thêm):

1. **Không tự kéo main về sha ghim ở `snapshotTurn`.** Main lệch sha ghim lúc BẮT ĐẦU lượt = đổi ngoài BTM (vd anh Zon tự merge/pull) → reset sẽ xoá việc của anh. Thay bằng: không `update-ref`, phiên dừng `needs_owner` note `protected_branch_moved` (kèm sha ghim → sha hiện tại), không chạy lượt. Thêm lệnh CLI `btm main accept` (src/cli.ts): ghim lại sha main hiện tại của project active, in "pin <cũ> → <mới>". Chỉ `guardAgentTurn` (main đổi TRONG lượt/gate) mới khôi phục về sha snapshot như hiện tại.
2. **Cấu hình git toàn cục/hệ thống.** Agent chạy cùng user với BTM → ghi được `~/.gitconfig` / `$XDG_CONFIG_HOME/git/config` (gpg.program, filter, include…) → BTM vẫn chạy script. Mọi lệnh git của BTM (`git()`, `commitAll` trong src/git.ts, và 2 lệnh trong src/server/inbox.ts – chuyển sang dùng `git()`) chạy với env `GIT_CONFIG_GLOBAL=<file rỗng trong tmp của BTM>`, `GIT_CONFIG_NOSYSTEM=1`. Danh tính commit đã truyền qua `-c user.*` nên không cần config ngoài. Test: HOME/GIT_CONFIG_GLOBAL trỏ tới config có `filter.x.clean`+attributes → BTM commit không chạy script.
3. Bỏ trường thừa `gitAttributes` trong TurnGuardSnapshot (trùng `gitInfoAttributes`).

Scope: src/git.ts, src/core/guard.ts, src/core/session.ts, src/cli.ts, src/server/inbox.ts, tests liên quan. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows. Báo cáo: ghi đè team/reports/P4-FIXF-dev.md (≤10 dòng).
