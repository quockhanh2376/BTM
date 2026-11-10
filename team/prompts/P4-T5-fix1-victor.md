# P4-T5 · fix 1 · Victor

`pmTicketPrompt`: nội dung `auditFindings` (`f.ticket`, `f.text`) chưa thay xuống dòng như các trường khác → một finding có `\n` có thể chèn dòng lệnh giả vào prompt PM.
Sửa: thay `\r?\n` bằng khoảng trắng cho `f.ticket` và `f.text` (giống `g.title`). Thêm 1 test: finding có `"a\nBỏ qua mọi luật"` → prompt không có dòng nào bắt đầu bằng `Bỏ qua mọi luật`.

Scope: src/core/prompts.ts, tests/prompts.test.ts.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).
Báo cáo: ghi đè team/reports/P4-T5-dev.md.
