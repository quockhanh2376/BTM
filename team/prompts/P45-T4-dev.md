# P4.5-T4 · Dev · Session/host/approve dùng repo tin cậy

Plan: docs/superpowers/plans/2026-11-10-btm-plan4-5-agent-isolation.md – làm ĐÚNG Task 4. Dùng sẵn: `wrapForWorker`/`workerKillAll` (src/isolation/worker.ts), `trustedRepoPath`/`ensureTrustedRepo`/`importGoalBundle`/`syncWorkspace(cfg, project, branch, sha, exec)` (src/isolation/trusted.ts). Test TRƯỚC.

Chỉ khi `cfg.host.worker_user` có (isolation bật):
1. Đầu mỗi lượt (pm/dev/qc/audit, cả lệnh trực tiếp host): `syncWorkspace` về sha nhánh goal trong repo tin cậy (goal chưa có trong tin cậy → tạo từ main tin cậy).
2. Sau lượt pm/dev: `importGoalBundle` → kiểm gate phần git (commit có mã ticket, scope, ticket_tampered) trên REPO TIN CẬY với dải `<sha goal tin cậy>..refs/btm/incoming/G<n>`; đạt → `update-ref refs/heads/<goal branch>` trong repo tin cậy; không đạt / bundle lỗi → lượt rejected (lý do như cũ hoặc `bundle_invalid`/`bundle_wrong_ref`), repo tin cậy KHÔNG đổi. qc/audit: không nhập bundle.
3. `approveGoal`: merge trong repo tin cậy (bare: dùng `git merge-tree --write-tree` + `commit-tree` + `update-ref`, hoặc worktree tạm của BTM); `protected_sha` theo repo tin cậy.
4. `init`/`migrate`: `ensureTrustedRepo` khi isolation bật.
5. Isolation tắt → hành vi y như cũ; TOÀN BỘ test cũ phải xanh. Guard Plan 4 giữ nguyên.

Tests (exec giả chạy git trực tiếp, không sudo): lượt dev sửa main + .git/config trong workspace → main tin cậy không đổi, lượt sau workspace về đúng sha; commit thiếu mã ticket trong bundle → rejected, nhánh goal tin cậy không đổi; approve merge vào main tin cậy.
Có thể không chạy được vitest trong sandbox – vẫn PHẢI viết test; Cheki chạy. `npx tsc --noEmit` sạch. Báo cáo: team/reports/P45-T4-dev.md (≤10 dòng).
