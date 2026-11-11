# P6 Task 3+4 review 1 – diff/ghi chú dòng, câu hỏi chặn ticket

Reviewer độc lập (chỉ đọc code). Không có chèn HTML hay chèn tham số git; luật cứng (người code ≠ QC/Audit, main được bảo vệ) giữ được.

| # | Mức | Vấn đề | Xử lý |
|---|---|---|---|
| H1 | High | QC hỏi (`confirm` có "?") biến "fail" thành "pass" trên thực tế (đặt lại base, bỏ ghi chú QC) | Đổi thiết kế: chỉ câu hỏi của Dev mới chặn; `confirm` của QC chỉ để tham khảo |
| H2 | High | Dev hỏi ở vòng ≥2 thì base về null, QC không còn xem các vòng trước | Giữ code đã commit và giữ base; ticket về `returned`; goal dừng chờ anh trả lời |
| H3 | High | "Cần xác nhận: Không có câu hỏi" bị tính là câu hỏi và xoá cả lượt Dev | Chỉ tính câu có "?" (ngoài URL); không xoá code nữa; prompt Dev ghi rõ câu hỏi kết thúc bằng "?" |
| M4 | Med | Ghi chú và câu trả lời bị đánh dấu đã dùng dù lượt bị bỏ | Đánh dấu sau khi commit; không còn bỏ lượt |
| M5 | Med | Ticket phụ thuộc bị chặn làm phiên dừng sớm | Dev hỏi thì dừng cả goal ngay (không chạy ticket khác) |
| M6 | Med | Diff gồm cả commit của ticket làm sau | Diff tính từ base tới commit cuối có tiêu đề `<ticket>: …` |
| M7 | Med | Dòng "++ x" trong hunk đổi tên file hiển thị | Chỉ nhận header `---`/`+++` trước `@@` đầu tiên |
| M8 | Med | Return không kiểm trạng thái, giữ số vòng sửa, tạo phiên chồng | Chỉ nhận ticket passed/returned/failed; số vòng sửa về 0; từ chối khi đã có phiên đang chờ |
| L9 | Low | `git clean` xoá file chưa track | Đã bỏ `reset --hard`/`clean` |
| L10 | Low | Diff > 20 MB trả 500 | Trả `truncated` |
| L12 | Low | Không đọc được nhãn `**Cần xác nhận:**` | Đã bỏ `**` trước khi parse |
| L13 | Low | Đang có phiên chạy thì không ghi chú được | Ghi chú cho phép lúc đang chạy; chỉ Return mới cần rảnh |
| L11, L14 | Low | Đường dẫn có dấu cách hiện kèm dấu nháy; trả lời câu hỏi không kiểm phiên đang chạy | Chấp nhận |
