# Bảng chữ giao diện (STRINGS)

Chữ hiển thị nằm trong `web/app/i18n.js`: `STRINGS.en` và `STRINGS.vi`, cùng key, cùng thứ tự.

Thêm một chuỗi:

1. Thêm `'nhom.key': 'English text'` vào `STRINGS.en`.
2. Thêm cùng key, cùng vị trí vào `STRINGS.vi` với chữ tiếng Việt; giữ nguyên `{placeholder}` và các từ sản phẩm (Goal, Ticket, Dev, QC, PM, Audit, Boss, Skill, Meeting, Log, Diff…); gọi chủ là "anh".
3. Dùng qua `tx('nhom.key', vars)` hoặc thuộc tính `data-i18n` / `data-i18n-aria` / `data-i18n-placeholder` / `data-i18n-title`.
4. Thêm một dòng vào bảng dưới.

Nút EN/VI ở đầu trang lưu `localStorage['btm.lang']` rồi tải lại trang (nhiều chữ được `tx()` một lần lúc tải). Test trong `tests/web.test.ts` bắt key thiếu ở `vi`, `{placeholder}` bị mất và chuỗi rỗng. Thoại bong bóng chat là bảng riêng (`CHAT_LINES`).

| mb.* / acc.idTitle | Thẻ key Boss (Z.ai): lưu, bật/tắt, xoá, trạng thái …4 ký tự cuối; nhãn 'Backup · mọi ghế'; ID Worker | Boss key card, badge, worker ID |
