# P4-T6 · Qeen · Review phiên theo goal

Đọc: Task 6 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T6-victor.md (phần "Quyết định đã chốt"), team/reports/P4-T6-dev.md.

**Kiểm (đọc code session.ts kỹ):**
1. `git status --short`: chỉ file trong scope; card.ts, snapshot.ts không đổi.
2. Luật cứng cũ còn nguyên: giới hạn lượt tổng/theo ghế + lượt dự phòng PM, timeout, scope, coder ≠ QC, max_fix_rounds, abort/Ctrl-C, WIP commit, inbox note.
3. PM ghi ticket sai (ID trùng/< nextTicketSeq/sai KEY, number trùng, size L, file ngoài team/tickets/) → needs_owner, không lượt Dev.
4. Nhánh goal đúng tên, tạo từ protected_branch; phiên 2 tiếp tục đúng nhánh, ticket passed không chạy lại, counter không reset.
5. Mọi commit Core bắt đầu `<ID>: ` hoặc `G<n>: `; gate bắt commit thiếu mã và báo cáo sai dòng mã.
6. Mọi đổi trạng thái ticket qua setTicketState (có history); goal → in_progress → qc_done; có team/goals/G<n>.md.
7. Test cũ không bị xoá vô cớ. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).

**Báo cáo:** team/reports/P4-T6-qeen.md

**Thêm sau fix1 (khôi phục test):**
8. So từng test với bản cũ (`git show HEAD:tests/session.test.ts`, `git show HEAD:tests/qc.test.ts`): test mới phải kiểm đúng ý cũ (cùng điều kiện, cùng kỳ vọng). Báo test "rỗng" (không assert, assert luôn đúng, expect bị bỏ) – mỗi cái 1 dòng.
9. 5 test bị bỏ (liệt kê trong team/reports/P4-T6-dev.md): lý do có đúng là tính năng đã bị thay hẳn không.
Ghi chú Cheki: trên Ubuntu full suite 585/585 ×3 lần.
