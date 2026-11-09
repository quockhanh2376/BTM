# P3-T6 · Qeen · Review OpenSpec khi tạo project

Đọc: team/prompts/P3-T6-victor.md (yêu cầu) và team/reports/P3-T6-dev.md.

**Kiểm:**
1. `git diff --stat` chỉ đụng file trong scope của prompt Victor.
2. openspec lỗi/timeout/không có lệnh → init KHÔNG fail, có cảnh báo trong docs/README-btm.md.
3. Lệnh openspec đúng tham số, chạy trong thư mục project (không phải repo BTM), có timeout.
4. Lệnh openspec không ghép chuỗi shell (không injection qua tên project).
5. pmPrompt chỉ thêm dòng OpenSpec khi `hasOpenspec` true.
6. `npx vitest run` không tăng fail so với ~21 fail Windows; `npx tsc --noEmit` sạch.

**Báo cáo:** `team/reports/P3-T6-qeen.md`.

Ghi chú Cheki: line ending CRLF do Antigravity tạo đã được đổi về LF; bỏ qua khác biệt line ending.
