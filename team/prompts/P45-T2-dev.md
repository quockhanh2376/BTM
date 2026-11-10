# P4.5-T2 · Dev · Runner + gate chạy dưới worker

Plan: docs/superpowers/plans/2026-11-10-btm-plan4-5-agent-isolation.md – làm ĐÚNG Task 2 (đọc Global Constraints + Interfaces của Task 2). Test TRƯỚC rồi code.
- Config `host.worker_user?`, `host.trusted_root?`; `src/isolation/worker.ts`: `wrapForWorker`, `workerKillAll(cfg, exec?)`.
- Runner (src/runner/run.ts) + gate (src/gate/gate.ts) dùng `wrapForWorker`; `workerKillAll` sau mỗi lượt (ok/timeout/abort/lỗi) và sau từng lệnh gate.
- Không có `worker_user` → hành vi y như cũ (mọi test cũ phải xanh).
- Test không gọi sudo thật (truyền `exec` giả).
Bạn có thể không chạy được vitest trong sandbox – vẫn PHẢI viết test; Cheki sẽ chạy. `npx tsc --noEmit` phải sạch.
Báo cáo: team/reports/P45-T2-dev.md (≤10 dòng: file đổi, test thêm).
