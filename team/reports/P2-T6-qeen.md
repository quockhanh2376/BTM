Bug: `web/index.html:202,897` — Theme tối: chữ trắng trên nút xanh chỉ đạt 2,19:1; chữ lỗi đỏ trên nền tối khoảng 2,5–2,8:1, vi phạm ≥4,5:1.
Bug: `web/index.html:861` — Nếu đọc localStorage ném lỗi, bỏ qua luôn `prefers-color-scheme`; máy chọn tối vẫn hiện sáng.
Cần sửa: `tests/web.test.ts` — Regex xóa comment `//` nuốt cả phần URL trong chuỗi; thử `<script src="https://evil.example/a.js"></script>` vẫn lọt test cấm mạng.
Cần sửa: `web/index.html:1017,1115,1180` — Hiện nguyên trạng thái tiếng Anh (`awaiting_approval`, `passed`, `queued`…), trái yêu cầu giao diện tiếng Việt.
Cần xác nhận: Task 6 Step 6 — Cheki kiểm tra thực tế 1280/375 px ở hai theme và ngắt/nối lại SSE; test hiện tại chỉ dò chuỗi, chưa chứng minh các hành vi này.