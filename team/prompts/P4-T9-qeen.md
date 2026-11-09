# P4-T9 · Qeen · Review dashboard theo goal

Đọc: Task 9 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T9-victor.md, team/reports/P4-T9-dev.md.

**Kiểm:**
1. `git status --short`: chỉ file trong scope; card.ts + card.test.ts đã xoá; không còn import card.ts; test khác không bị xoá.
2. Stage tính đúng cho từng state goal/ticket; passed/total đúng.
3. POST /api/goal/approve: thiếu x-btm/Origin lạ → 403; JSON sai → 400; chưa sẵn sàng/đang chạy → 409; không tự merge khi bị lỗi.
4. Web: nội dung agent chèn bằng textContent (không innerHTML) → không XSS; nút là `<button>`, có confirm; 6 nhãn chặng tiếng Việt; tương phản ≥ 4.5:1 hai theme.
5. Project không có team/project.yaml → dashboard vẫn chạy, goals rỗng.
6. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).

**Báo cáo:** team/reports/P4-T9-qeen.md
