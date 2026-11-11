# P6 Task 2 review 1 – hết hạn mức giữa lượt

Reviewer độc lập (chỉ đọc code). Luật cứng giữ được: người code ≠ QC và ≠ Audit, kể cả khi agent báo hết hạn mức giả.

| # | Mức | Vấn đề | Xử lý |
|---|---|---|---|
| H1 | High | Detect đọc cả `lastMessage` (chữ của agent): agent in giả `…limit reached|9999999999` thì tự cho mình nghỉ vô thời hạn, không gỡ được | Đã sửa: chỉ đọc output của CLI, cần exit code thật; giờ hồi tối đa 7 ngày; monitor tự gỡ cờ khi Energy thật còn đủ |
| M2 | Med | Bấm Dừng nhưng vẫn tự Tiếp tục | Đã sửa: Dừng huỷ lần tự Tiếp tục đang chờ |
| M3 | Med | Tự Tiếp tục hỏng thì không ai được báo | Đã sửa: hỏng thì gửi ntfy và chạy hàng đợi |
| M4 | Med | Có thể Tiếp tục nhầm phiên nếu đổi project | Đã sửa: chỉ tự Tiếp tục khi project active không đổi |
| M5 | Med | Mẫu Claude/agy quá rộng, dễ nhận nhầm | Đã sửa: Claude cần "limit reached … resets <giờ>" hoặc epoch; agy cần "Individual quota reached" |
| L6 | Low | Giờ hồi Codex/Claude hiểu là trong 24 giờ tới, theo giờ VM | Chấp nhận (VM chạy UTC, Codex in cùng múi) |
| L7 | Low | HH:mm hiển thị giờ UTC | Như các thông báo Energy hiện có; để sau |
| L8 | Low | Bộ đếm tự Tiếp tục nằm trong bộ nhớ | Chấp nhận (tối đa 2 lần/phiên, không lặp) |
| L10 | Low | Người dự phòng đang bị cờ vẫn tính là có người thay | Đã sửa: `backupsFor` bỏ agent đang bị cờ |
