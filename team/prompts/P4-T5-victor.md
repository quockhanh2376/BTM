# P4-T5 · Victor · Prompt PM/Dev/QC + kết quả QC theo ticket

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 5** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md (bản đã sửa).

**Quan trọng:** thêm hàm MỚI tên mới (`pmTicketPrompt`, `devTicketPrompt`, `qcTicketPrompt`, `parseTicketQcResult`). KHÔNG sửa/xoá `pmPrompt`, `devPrompt`, `qcPrompt`, `parseQcResult` cũ (session.ts còn dùng tới Task 6).

**Scope:** src/core/prompts.ts, src/qc/result.ts, src/ticket/ticket.ts (chỉ thêm `AuditFinding`), tests/prompts.test.ts (mới), tests/qc.test.ts

**Nội dung prompt (ngắn, tiếng Việt, theo phong cách hàm cũ):**
- PM: ghi ticket vào `team/tickets/<ID>.md`, mỗi file 1 ticket cho goal `G<n>`; ID bắt đầu từ `<nextId>`, tăng dần, KEY `<key>`; `number`/`of` liên tục 1..N; đủ trường bắt buộc + `type` (feat|fix|chore|security) + `size` (S|M|L); size L phải tách nhỏ; chỉ ghi team/tickets/, cấm commit/push. Có `auditFindings` → viết ticket sửa mới `from_audit: true`, number tiếp theo, liệt kê từng finding.
- Dev/QC: đọc `team/tickets/<ID>.md`; dòng đầu báo cáo đúng `reportHeader(t, agentName, 'Dev'|'QC')`; giữ các dòng luật như hàm cũ (scope, cấm commit, allow, BLOCKED, ≤5 dòng Bug/Cần sửa/Cần xác nhận).
- QC JSON thêm `"ticket"`, `"goal"`, `"number"`.

**Test:** đủ case Task 5 trong plan.
**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).
**Báo cáo:** team/reports/P4-T5-dev.md
