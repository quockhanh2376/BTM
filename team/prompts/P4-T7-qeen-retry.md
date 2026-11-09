NHẮC: lượt trước bị dừng vì chạy `git diff src/server/snapshot.ts` (lệnh có thêm tham số bị CHẶN, cả lượt mất kết quả). Chỉ dùng `git diff` (toàn bộ) hoặc `git diff --stat`, rồi đọc từng file bằng công cụ đọc file.

# P4-T7 · Qeen · Review ghế audit

Đọc: Task 7 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, docs/tickets.md §5, team/prompts/P4-T7-victor.md, team/reports/P4-T7-dev.md.

**Kiểm:**
1. `git status --short`: chỉ file trong scope. Số test không giảm (so `git diff --stat` tests/ – không có test bị xoá).
2. Không cấu hình audit → hành vi y như trước (goal dừng `qc_done`).
3. `parseAuditResult`: JSON hỏng/lẫn văn xuôi → fail `audit_output_invalid`; high/medium + verdict pass → ép fail; không bao giờ pass sai.
4. Auditor là coder của goal → needs_owner; audit sửa repo → fail.
5. Audit fail → PM tạo ticket `from_audit: true` mới, chỉ ticket mới bị kiểm ID; ticket cũ không chạy lại; vòng lặp bị chặn bởi giới hạn lượt.
6. PM sửa/xoá ticket có sẵn → needs_owner `pm_modified_existing_ticket` và file được khôi phục.
7. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).

**Báo cáo:** team/reports/P4-T7-qeen.md
8. Audit lỗi hệ thống (audit_output_invalid / audit_modified_repo / fail không finding) → needs_owner, KHÔNG gọi PM.
Ghi chú Cheki: Ubuntu 612/612 ×3 lần.
