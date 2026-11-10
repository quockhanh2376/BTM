# P4-T4 · Qeen · Review gate mã ticket

Đọc: Task 4 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, team/prompts/P4-T4-victor.md, team/reports/P4-T4-dev.md.

**Kiểm:**
1. `git status --short`: chỉ file trong scope prompt Victor (+ báo cáo); `runGate` và session.ts không đổi.
2. `commitsMissingTicketId`: chỉ xét `base..HEAD`; `GTM-00123: x` hay `GTM-0012 x` (thiếu ": ") bị bắt; subject có ký tự lạ/tiếng Việt không làm hỏng; không ghép chuỗi shell.
3. `reportHeaderOk`: bỏ dòng trống đầu, so đúng `<ID> · G<n>#<k>/<of> · `, thiếu file → false, CRLF trong file vẫn đúng.
4. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).

**Báo cáo:** team/reports/P4-T4-qeen.md
