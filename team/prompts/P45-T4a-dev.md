# P4.5-T4a · Dev · approveGoal + init/migrate trên repo tin cậy (phần 1/3 của Task 4)

Phạm vi NHỎ, làm XONG trong lượt này (không dừng giữa chừng để báo "chưa làm"). Đọc Task 4 trong docs/superpowers/plans/2026-11-10-btm-plan4-5-agent-isolation.md.
Chỉ khi `cfg.host.worker_user` có:
1. `src/ticket/goal.ts` `approveGoal`: merge `goal.reviewed_sha` vào `refs/heads/main` của REPO TIN CẬY (`trustedRepoPath(cfg, repo)`, bare). Cách: `git merge-tree --write-tree <main> <reviewed_sha>` → lỗi xung đột thì từ chối như hiện tại; được thì `git commit-tree <tree> -p <main> -p <reviewed_sha> -m "merge G<n>: <title>"` (danh tính `-c user.name=btm -c user.email=btm@btm.local`) → `git update-ref refs/heads/main <mới> <main cũ>`. Ghim `protected_sha:<repo>` = sha mới. Các kiểm tra hiện có (reviewed_sha, lệnh trực tiếp, pin) giữ nguyên nhưng đọc từ repo tin cậy.
2. `src/project/init.ts`, `src/project/migrate.ts`: gọi `ensureTrustedRepo(cfg, project)` sau khi xong việc hiện tại; migrate ghim sha main tin cậy.
3. Isolation tắt → y như cũ.
Tests (tests/goal.test.ts, tests/migrate.test.ts): cfg có worker_user + trusted_root tmp; repo tin cậy tạo bằng ensureTrustedRepo; goal có reviewed_sha trong tin cậy (fetch vào) → approve → main tin cậy có merge commit 2 cha, workspace main KHÔNG đổi; xung đột → từ chối, main tin cậy không đổi; migrate tạo repo tin cậy.
Dùng `git()` của src/git.ts cho mọi lệnh. Có thể không chạy được vitest – vẫn viết test; `npx tsc --noEmit` sạch. Báo cáo: team/reports/P45-T4a-dev.md (≤8 dòng).
