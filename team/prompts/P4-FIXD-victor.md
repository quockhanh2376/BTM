# P4-FIX-D · Victor · Bảo vệ main chống agent cố tình (review 2: B1 B2 B3 B7)

Chi tiết: team/reviews/P4-review-2.md. Viết test TRƯỚC (thấy FAIL) rồi sửa.

1. **B1 – luôn dùng ref đầy đủ.** Mọi chỗ BTM đọc/ghi nhánh trong src/core/guard.ts, src/ticket/goal.ts (approveGoal), src/project/migrate.ts, src/core/session.ts: dùng `refs/heads/<tên>` (rev-parse, update-ref, merge, checkout dùng `git checkout <tên>` nhưng kiểm bằng `git symbolic-ref HEAD` == `refs/heads/<goal>`). Test: agent commit lên main rồi `git tag main <sha cũ>` → main (refs/heads) vẫn được khôi phục.
2. **B2 – ghim sha khi QC/audit xong.** Bảng `goals` thêm cột `reviewed_sha` (migration `ALTER TABLE` như các cột cũ trong db.ts); khi goal → `qc_done` (không audit) hoặc `audit_passed`: lưu sha `refs/heads/<goal.branch>`. `approveGoal`: refs/heads/<goal.branch> ≠ reviewed_sha → từ chối code `not_ready`, message "nhánh goal đã đổi sau khi QC/audit". Merge bằng **sha** (`git merge --no-ff <reviewed_sha>`), không bằng tên. Guard: snapshot thêm sha của MỌI `refs/heads/goal/*`; sau lượt, nhánh goal khác nhánh đang làm bị đổi/xoá/tạo mới → khôi phục bằng update-ref (xoá cái mới tạo), vi phạm `agent_modified_other_goal`.
3. **B3 – tắt hook & config nguy hiểm.** Helper `git()` (src/git.ts) và mọi lệnh git BTM tự chạy luôn thêm `-c core.hooksPath=<thư mục rỗng do BTM tạo trong os.tmpdir()> -c core.fsmonitor=false`. (Không áp dụng cho git mà agent tự chạy.) Test: repo có `.git/hooks/post-commit` sửa main → `commitAll` của BTM không chạy hook, main không đổi.
4. **B7 – nhánh bị xoá.** main bị xoá trong lượt → tạo lại bằng `update-ref refs/heads/<protected> <protectedHead>`, vi phạm `agent_modified_protected_branch` (không nuốt lỗi). Nhánh goal bị xoá → tạo lại tại `preHead` rồi checkout, vi phạm `agent_switched_branch`.

Scope: src/core/guard.ts, src/git.ts, src/ticket/goal.ts, src/store/db.ts, src/core/session.ts, src/project/migrate.ts, tests/*.test.ts liên quan. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: team/reports/P4-FIXD-dev.md (≤10 dòng, con số thật).
