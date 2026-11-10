# P4-T10 · fix 2 · Victor

Báo cáo fix1 ghi "không tăng fail" nhưng SAI: Windows từ 15 → 18 fail, 3 test mới hỏng, đều trong tests/migrate.test.ts (lỗi của test, không phải do Windows):
1. `btm migrate --key GTM chạy cho project active…`, `…đang có phiên (bị khoá btm.lock)…`, `…chưa có active project…` → config test thiếu mục `rules, energy, login, gate, plugins, runner` → "Config validation error". Dùng config đầy đủ: copy `btm.config.yaml` của repo rồi chỉ đổi `host.*` (như tests/init.test.ts đang làm).
2. Có lệnh `git commit --allow-empty -m init` không truyền danh tính → lỗi trên máy không có git user toàn cục. Dùng helper `tmpRepo` (tests/helpers.ts) hoặc thêm `-c user.name=… -c user.email=…`.

Scope: tests/migrate.test.ts. Không giảm số test.
Xong khi: `npx vitest run` đúng **15** fail Windows như trước (không có fail nào trong tests/migrate.test.ts).
Báo cáo: ghi đè team/reports/P4-T10-dev.md, ghi CON SỐ thật từ `npx vitest run`.
