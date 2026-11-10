# P4-T7 · Victor · Ghế audit (Kai) tuỳ chọn + siết PM

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 7** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md; checklist audit ở docs/tickets.md §5.

**Scope:** src/config.ts, src/core/prompts.ts, src/core/session.ts, src/audit/result.ts (mới), src/server/snapshot.ts (CHỈ nếu tsc gãy vì Seat có thêm 'audit'), tests/config.test.ts, tests/audit.test.ts (mới), tests/session.test.ts

**Quyết định đã chốt:**
- Config không có `seats.audit` → bỏ qua audit, goal dừng ở `qc_done` như hiện tại (mọi test cũ phải xanh không đổi).
- Agent audit ≠ mọi agent đã code ticket nào của goal (xem `turns` seat dev của các ticket goal) → vi phạm: `needs_owner`, lý do `auditor_is_coder`.
- Audit read-only như QC: sau lượt audit mà working tree bẩn hoặc có commit mới → fail `audit_modified_repo` (giống `qc_modified_repo`). Core tự ghi `team/reports/G<n>-audit.md` từ output (agent không cần ghi) rồi commit `G<n>: audit <verdict>`.
- Audit fail → lượt PM với `auditFindings` → kiểm ticket MỚI (chỉ ticket mới phải có ID ≥ nextTicketSeq; ticket cũ của goal giữ nguyên) → ticket mới chạy Dev/QC → audit lại. Giới hạn bởi lượt phiên như mọi lượt khác.
- **Siết PM (cả lượt PM đầu goal):** PM chỉ được TẠO file mới trong team/tickets/; sửa/xoá file ticket đã có (của bất kỳ goal nào) → needs_owner `pm_modified_existing_ticket`, khôi phục file.

**Test:** đủ case Task 7 trong plan + `auditor_is_coder`, `audit_modified_repo`, `pm_modified_existing_ticket`.
**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows); KHÔNG giảm số test.
**Báo cáo:** team/reports/P4-T7-dev.md
