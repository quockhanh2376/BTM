# P4-T1 · Qeen · Review ticket schema

Đọc: Task 1 trong docs/superpowers/plans/2026-11-09-btm-v1-tickets.md, docs/tickets.md §3 + §7, team/reports/P4-T1-dev.md.

**Kiểm:**
1. `git status --short`: chỉ src/ticket/ticket.ts, src/ticket/goal.ts, tests/ticket.test.ts (cộng file báo cáo).
2. Mọi interface trong plan có đúng tên/kiểu; mọi case test trong plan có test tương ứng.
3. Ticket ID phải đúng KEY truyền vào; number ≤ of; acceptance 1–5; type/size đúng enum; scope không `..`/tuyệt đối/khoảng trắng.
4. `loadTickets`: bỏ symlink, ném khi trùng id hoặc trùng number trong goal; sort goal rồi number (G2 sau G1, G10 sau G9).
5. `slugify`: tiếng Việt bỏ dấu, đ→d, ≤30 ký tự, không kết thúc '-', rỗng → 'goal'.
6. `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (21 Windows).

**Báo cáo:** team/reports/P4-T1-qeen.md
