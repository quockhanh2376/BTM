# 0001 – Goal & Ticket thay cho thẻ task T-xxx

- Ngày: 2026-11-09 · Người quyết: anh Zon · Ghi lại: Cheki

## Bối cảnh
v1.0 dùng thẻ task `T-001…` đánh số lại theo từng phiên, không gắn với mục tiêu anh giao. Khi một mục tiêu lớn (vd "UI login + reset pass") cần nhiều đầu việc, không ai biết mục tiêu đã xong bao nhiêu, và các agent không có mã chung để đối chiếu.

## Quyết định
1. Mục tiêu anh giao = **Goal `G<n>`**. PM chia mỗi goal thành **ticket** theo khối lượng việc.
2. Ticket có **Ticket ID** duy nhất toàn project (`<KEY>-<nnnn>`, không dùng lại) và **ticket number** trong goal (`G1#3/9`).
3. PM, Dev, QC (và Audit) ghi mã ticket ở đầu mọi báo cáo; Core kiểm tra mã khớp.
4. Thêm ghế tuỳ chọn **audit (Kai – Cyber Security Analyst)**: review bảo mật toàn goal sau QC, trước khi anh duyệt merge vào `main`.
5. Chỉ anh Zon duyệt merge (`git.merge_by: owner` giữ nguyên).

Chi tiết: `docs/tickets.md`.

## Hệ quả
- Đổi tên `team/tasks/` → `team/tickets/`, `T-xxx` → Ticket ID; gate, QC, dashboard, inbox note dùng Ticket ID.
- Thêm bảng `goals`, `tickets` vào SQLite; bộ đếm Ticket ID theo project.
- Bước audit thêm 1 lượt/goal (tốn hạn mức của Kai), bù lại có kiểm tra bảo mật độc lập trước khi vào `main`.
- Kế hoạch 4 sẽ hiện thực; v1.0 hiện tại vẫn chạy với `T-xxx` cho tới khi Kế hoạch 4 merge.
