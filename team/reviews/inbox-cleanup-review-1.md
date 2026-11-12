# Review: inbox-cleanup (xoá ghi chú, inbox thu gọn, đổi thứ tự) — 2026-11-12

Reviewer độc lập (subagent), chỉ đọc code.

- **High:** không có. Git an toàn (cây sạch, ghim, detached HEAD, reset khi lỗi), tên file kiểm bằng regex, UI dùng textContent.
- **Medium – xoá note đang mở của phiên chờ** (needs_owner/stopped): phiên Resume mất ảnh/note. → **Đã sửa:** bỏ qua note `open` của phiên running/needs_owner/stopped, trả `skipped`; chỉ còn note đó → 409. Test trong `tests/http.test.ts`.
- **Low – toggle đóng ngay khi chạm/Tab** (mouseenter/focusin mở rồi click đóng). → **Đã sửa:** click trong 600 ms sau khi tự mở thì giữ mở.
- **Low – note commit trên nhánh goal/… chưa merge:** main không có file, DB xoá; merge goal sau đó đưa file về main mà không có dòng DB. → **Ghi nhận**, đúng giới hạn đã báo anh trong thiết kế (chỉ xoá trên main).
- Ghi chú: chưa có ghim thì ghim luôn SHA main mới (approveGoal ghim SHA hiện tại trước) — kết quả tương đương, để nguyên.
