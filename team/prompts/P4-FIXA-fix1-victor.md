# P4-FIX-A · fix 1 · Victor

`guardAgentTurn` còn lỗ hổng chính của review #1: agent `git checkout main` rồi **commit** trên main → guard chỉ quay về nhánh goal, **main giữ commit của agent**. Test hiện tại (tests/session.test.ts ~3244 "QC chạy git checkout main…") chỉ checkout, KHÔNG commit, nên không bắt được.

**Sửa (src/core/session.ts):**
1. `snapshotTurn` ghi thêm `protectedHead` = sha của `cfg.git.protected_branch` trước lượt.
2. `guardAgentTurn` sau lượt: sha protected branch ≠ `protectedHead` → `git update-ref refs/heads/<protected> <protectedHead>` (không đụng working tree), vi phạm `agent_modified_protected_branch` (với qc/audit tính là fail như modified_repo; với pm/dev là needs_owner). Làm bước này TRƯỚC khi checkout lại nhánh goal.
3. Áp dụng cho mọi ghế (pm, dev, qc, audit) và mọi kết quả (ok/timeout/lỗi/abort).

**Test (sửa + thêm):** QC `checkout main` + sửa file + `git commit` → sau phiên `rev-parse main` == trước, nhánh hiện tại là nhánh goal, verdict fail; Dev làm tương tự → main không đổi, needs_owner `agent_modified_protected_branch`; PM tương tự.

Scope: src/core/session.ts, tests/session.test.ts. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: ghi đè team/reports/P4-FIXA-dev.md (≤10 dòng, con số thật).
