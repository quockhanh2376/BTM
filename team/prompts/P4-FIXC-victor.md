# P4-FIX-C · Victor · Lệnh trực tiếp từ dashboard đi qua guard

Vấn đề: "Khung lệnh" trên dashboard gửi lệnh thẳng cho Dev/QC (src/server/host.ts `processQueue`, ~dòng 120–230) gọi runner KHÔNG qua `guardAgentTurn`, và commit (`checkpoint before cmd …`, `cmd <id>: …`) lên **nhánh đang checkout bất kỳ** – kể cả `main`. Lỗ hổng giống review #1.

**Sửa:**
1. Tách `snapshotTurn` + `guardAgentTurn` (và type đi kèm) từ src/core/session.ts ra file mới `src/core/guard.ts`, export; session.ts import lại – KHÔNG đổi hành vi (mọi test session phải xanh nguyên).
2. `processQueue`: trước khi chạy lệnh dev/qc, nhánh hiện tại phải là nhánh goal (`goal/G…`) – nếu là `cfg.git.protected_branch` hoặc không phải nhánh goal → không chạy, item `cancelled`, turn/session ghi lý do `direct_cmd_needs_goal_branch` (dashboard hiện lỗi qua cơ chế sẵn có). Bỏ commit `checkpoint before cmd` (tree bẩn → từ chối `dirty_tree`, như đầu phiên).
3. Lượt dev/qc trực tiếp: snapshot trước, `guardAgentTurn` sau ở mọi nhánh (ok/timeout/lỗi/abort/throw); dev commit với message bắt đầu `G<n>: cmd <id>: …` (n lấy từ tên nhánh goal); qc không được sửa repo (guard xử lý).

**Test (tests/host.test.ts):** đang ở main → lệnh dev bị từ chối, main không đổi, không runner call; đang ở nhánh goal → chạy, commit đúng prefix; dev lệnh trực tiếp checkout main + commit → main được khôi phục; qc lệnh trực tiếp sửa file → bị huỷ. Test session cũ không đổi.

Scope: src/core/guard.ts (mới), src/core/session.ts (chỉ tách/import), src/server/host.ts, tests/host.test.ts. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: team/reports/P4-FIXC-dev.md (≤10 dòng, con số thật).
