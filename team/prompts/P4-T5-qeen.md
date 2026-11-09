# P4-T5 · Qeen · Review prompt theo ticket

Đọc: Task 5 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T5-victor.md, team/reports/P4-T5-dev.md.

**Kiểm:**
1. `git status --short`: chỉ file trong scope (+ báo cáo). 4 hàm cũ không đổi.
2. Prompt PM đủ: đường dẫn team/tickets/, G<n>, nextId, KEY, trường bắt buộc, type/size, tách size L, cấm commit; auditFindings → ticket `from_audit: true`.
3. Dev/QC prompt: đúng file ticket, đúng chuỗi reportHeader; dữ liệu ticket có xuống dòng không phá prompt (như hàm cũ thay \n).
4. `parseTicketQcResult`: JSON không hợp lệ/lẫn văn xuôi/thiếu ticket/goal/number lệch → fail + qc_output_invalid; không bao giờ thành pass.
5. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).

**Báo cáo:** team/reports/P4-T5-qeen.md
