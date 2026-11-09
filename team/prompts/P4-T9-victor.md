# P4-T9 · Victor · Dashboard theo goal, pipeline, lịch sử, nút Duyệt merge

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 9** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md + docs/tickets.md §6–7. Bố cục, màu, theme sáng/tối giữ theo web/index.html hiện có.

**Scope:** src/server/snapshot.ts, src/server/http.ts, src/server/host.ts, web/index.html, xoá src/task/card.ts + tests/card.test.ts, tests/snapshot.test.ts, tests/http.test.ts, tests/web.test.ts

**Quyết định đã chốt:**
- Snapshot: bỏ trường `tasks` (T-xxx), thêm `goals` đúng interface trong plan; nguồn dữ liệu = `store.listGoals/listTickets/getTicketState` của project active + `loadTickets(repo, key)` cho title/type/size (không có `team/project.yaml` → `goals: []`, không lỗi).
- `seats[].ticket` = `task_id` của lượt đang chạy (null khi rảnh). Có `seats.audit` → hiện thêm thẻ ghế Kai-Audit.
- Stage "plan" = goal `in_progress` và (ghế pm đang giữ lượt hoặc goal chưa có ticket).
- Web: thay "Bảng task" bằng các nhóm goal (mới nhất trên cùng): tiêu đề `G1 · <tiêu đề> · 6/9 đạt`, thanh 6 chặng (chặng hiện tại tô đậm), bảng ticket giữ 5 tab trạng thái như cũ, dòng `#3/9 · GTM-0012 · <tiêu đề>`. Bấm dòng → mở dòng thời gian lịch sử (`GET /api/tickets/<id>/history`) ngay dưới dòng. Nút `<button>` **Duyệt merge** chỉ hiện khi goal `qc_done` (không audit) hoặc `audit_passed`; bấm → `confirm()` → `POST /api/goal/approve` (qua hàm post có header x-btm sẵn có) → hiện kết quả/lỗi.
- Nội dung từ agent (title, lý do lịch sử) chèn bằng `textContent`, không `innerHTML`.
- `POST /api/goal/approve`: body `{goal: "G<n>"}` (zod); đang có phiên/lượt → 409 `busy`; mã lỗi theo plan.

**Test:** đủ case Task 9 + snapshot project không có project.yaml → goals rỗng; title chứa `<script>` hiển thị dạng chữ (web test).
**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows); chỉ được giảm đúng số test của tests/card.test.ts.
**Báo cáo:** team/reports/P4-T9-dev.md
