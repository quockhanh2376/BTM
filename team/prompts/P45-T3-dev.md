# P4.5-T3 · Dev · Repo tin cậy + nhập bundle

Plan: docs/superpowers/plans/2026-11-10-btm-plan4-5-agent-isolation.md – làm ĐÚNG Task 3 (Interfaces + Review Focus mục 2, 3). Test TRƯỚC rồi code.
- Tạo `src/isolation/trusted.ts`: `trustedRepoPath`, `ensureTrustedRepo`, `importGoalBundle`, `syncWorkspace` (lệnh chạy dưới worker đi qua `wrapForWorker` từ src/isolation/worker.ts; mọi git của BTM dùng `git()` trong src/git.ts).
- Bundle chỉ nhận đúng 1 head `refs/heads/<goal branch>`; thêm main / refs/replace / tag / nhiều head → `bundle_wrong_ref`, hỏng → `bundle_invalid`; repo tin cậy không đổi khi từ chối.
- `exec` injectable để test chạy trực tiếp (không sudo).
- CHƯA nối vào session/host (Task 4).
Bạn có thể không chạy được vitest trong sandbox – vẫn PHẢI viết test (tests/trusted.test.ts, repo git thật trong tmp); Cheki sẽ chạy. `npx tsc --noEmit` phải sạch.
Báo cáo: team/reports/P45-T3-dev.md (≤10 dòng).
