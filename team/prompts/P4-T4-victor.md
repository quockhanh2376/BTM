# P4-T4 · Victor · Gate: commit có mã ticket, dòng mã báo cáo

Nhánh: plan4-tickets. Yêu cầu chính xác: **Task 4** trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md (bản đã sửa: KHÔNG đổi chữ ký `runGate` ở task này).

**Scope:** src/gate/gate.ts, src/git.ts (nếu cần helper), tests/gate.test.ts

**Làm:** thêm 2 hàm export trong gate.ts:
- `commitsMissingTicketId(repo, base, id): string[]` – dùng `git log --format=%H%x00%s base..HEAD` qua helper `git()` sẵn có (không ghép chuỗi shell); subject phải bắt đầu đúng `<id>: `.
- `reportHeaderOk(repo, t: Ticket): boolean` – theo plan.
Dùng `Ticket` từ src/ticket/ticket.ts. Không sửa `runGate`, không đụng session.ts.

**Test:** đủ case Task 4 trong plan (repo tạm bằng `tmpRepo` trong tests/helpers.ts như test cũ).
**Xong khi:** `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).
**Báo cáo:** team/reports/P4-T4-dev.md
