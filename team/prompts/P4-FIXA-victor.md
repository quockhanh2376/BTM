# P4-FIX-A · Victor · An toàn git quanh lượt agent (review #1 #2 #3 #4 #8)

Chi tiết lỗi: team/reviews/P4-review-1.md. Mọi sửa trong src/core/session.ts (+ tests/session.test.ts). Viết test TRƯỚC, thấy FAIL rồi mới sửa.

**Làm 1 hàm dùng chung** (ví dụ `guardAgentTurn`) cho MỌI lượt agent (pm, dev, qc, audit) – trước lượt ghi `{branch, head}` của nhánh goal; sau lượt (kể cả timeout/lỗi/abort):
1. Nhánh hiện tại ≠ nhánh goal → `git checkout -f <nhánh goal>` (không reset nhánh khác, không xoá nhánh agent tạo), lý do vi phạm `agent_switched_branch`. Tuyệt đối không chạy `reset --hard` khi chưa chắc đang ở nhánh goal.
2. HEAD nhánh goal khác `head` trước lượt (agent tự commit):
   - pm/dev: `git reset --soft <head>` để giữ thay đổi chưa commit, rồi đi tiếp luồng kiểm như bình thường (scope, ticket có sẵn…) – Core mới là người commit.
   - qc/audit: vi phạm `qc_modified_repo` / `audit_modified_repo` → `reset --hard <head>` (đang ở nhánh goal) + clean.
3. qc/audit: tree bẩn → như trên. Áp dụng CẢ khi qc/audit timeout, exit≠0, abort (#3) – không bao giờ WIP-commit thay đổi của qc/audit.
4. Dev timeout/lỗi/abort: commit WIP với `<ID>: WIP <lý do>` ngay (trên nhánh goal) – không để thay đổi chưa commit lại cho phiên sau.

**Đầu phiên (#2 #8):** tree bẩn → KHÔNG tự commit; trả `needs_owner` note `dirty_tree_at_start` kèm nhánh hiện tại (anh tự quyết). Bỏ commit `G<n>: checkpoint`.

**Test bắt buộc:** QC chạy `git checkout main` + commit → main KHÔNG đổi (so sha), quay về nhánh goal, verdict fail; QC tạo nhánh mới → phát hiện; Dev checkout main + sửa file → main không đổi; PM tự commit file ngoài team/tickets → `pm_out_of_scope`; QC timeout có sửa file → không có commit WIP chứa sửa đổi QC; Dev abort → có commit `<ID>: WIP aborted`, resume lần sau gate KHÔNG báo `commit_missing_ticket_id`; tree bẩn đầu phiên → needs_owner, không commit.

Scope: src/core/session.ts, tests/session.test.ts. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows. Báo cáo CON SỐ thật.
Báo cáo: team/reports/P4-FIXA-dev.md (≤10 dòng).
