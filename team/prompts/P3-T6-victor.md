# P3-T6 · Victor · OpenSpec khi tạo project

Plan: docs/superpowers/plans/2026-11-08-btm-v1-energy-accounts.md, Task 6.

**Scope:** src/project/init.ts, src/core/prompts.ts, src/core/session.ts (chỉ chỗ gọi pmPrompt), tests/init.test.ts, tests/prompts*.test.ts (nếu cần file mới)

**Làm:**
1. `initProject`: sau `git init`, trước commit "init", chạy `openspec init --tools claude,codex,antigravity --language vi --no-animation` trong thư mục project, timeout 60 s.
   - Lỗi (không có lệnh, exit ≠ 0, timeout) → ghi cảnh báo vào `docs/README-btm.md`, init vẫn thành công.
   - Commit "init" gồm cả `openspec/` nếu có.
   - Để test được trên Windows lẫn Linux: thêm tham số tuỳ chọn để inject hàm chạy openspec (mặc định gọi lệnh thật). Không dùng script giả trên PATH.
2. `pmPrompt`: thêm tham số tuỳ chọn `hasOpenspec`. Khi true thêm 1 dòng: đề xuất thay đổi bằng OpenSpec (`openspec/changes/<tên>`), mỗi thẻ ghi `openspec_change: <tên>`. `session.ts` truyền `existsSync(<project>/openspec)`.

**Test (viết trước, thấy FAIL rồi mới code):**
- openspec giả thành công → được gọi đúng tham số + cwd, `openspec/` nằm trong commit init.
- openspec giả lỗi → init vẫn thành công, có `docs/README-btm.md` chứa cảnh báo.
- pmPrompt có/không có dòng OpenSpec theo `hasOpenspec`.

**Xong khi:** `npx vitest run` không tăng số fail (hiện ~21 fail Windows), `npx tsc --noEmit` sạch.

**Luật:** không commit, không đổi nhánh, không cài package. Báo cáo → `team/reports/P3-T6-dev.md` (Bug / Cần sửa / Cần xác nhận, hoặc OK). Rồi sửa dòng P3-T6·V trong team/board.md thành `done`.
