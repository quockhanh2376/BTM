# Dòng thời gian ticket, tổng khối lượng, rút kinh nghiệm – thiết kế ngắn

Anh Zon duyệt 2026-11-14. Mục đích: truy vết khi có sai sót (ai làm, bước nào, bao lâu, kết quả, log) và để team học từ goal trước.

## Đã có sẵn
- `ticket_history`: đổi trạng thái (from → to, by, reason, at). Dashboard có hàng lịch sử mở ra được.
- `turns`: mỗi lượt có `task_id` = ID ticket, seat, agent, giờ, result, error, log_file.
- Nhật ký goal (`buildGoalDigest`), lưu `<data_dir>/knowledge/<KEY>/G<n>.md` sau khi duyệt.

## Làm
1. **Dòng thời gian ticket** – `GET /api/tickets/:id/trace` → `{ events, totals }`: trộn đổi trạng thái + lượt chạy theo giờ.
   Hàng lịch sử ticket hiện mọi sự kiện (giờ VN, ai, ghế, bước, thời lượng, kết quả) và nút "Log".
   `GET /api/turns/:id/log` trả ~300 dòng cuối, text/plain. Đường dẫn chỉ lấy từ DB, phải nằm trong thư mục log, lượt phải thuộc project đang mở. Web hiện bằng textContent.
2. **Tổng khối lượng** – mỗi ticket: số lượt, thời gian agent theo ghế, số vòng sửa, số lần bị trả về.
   Mỗi goal: thêm `byAgent` vào thời gian goal (thẻ goal + nhật ký goal).
3. **Rút kinh nghiệm** – duyệt goal xong (sau release + lưu nhật ký) xếp một việc `ask-lessons` (`G<n>`) vào hàng chờ của làn hỏi đáp (chỉ đọc, `noImport`).
   Ghế PM trước, bận thì ghế khác, cuối cùng là Boss. Agent trả `{"lessons":[…]}` (≤10, mỗi câu ≤300 ký tự).
   Ghi `<data_dir>/knowledge/<KEY>/lessons.md` và `<data_dir>/knowledge/lessons.md` (chung), dòng `- [KEY G<n>] …`, giữ 30 dòng mới nhất. Kết quả cũng hiện trong Meeting room.
   PM lập ticket được dán bài học (project trước, chung sau, tối đa 3.000 ký tự) làm tham khảo.
   Anh xem/sửa trong ô Lessons trên tab Goals (`GET/POST /api/lessons`, ≤20.000 ký tự). Ô search tìm được bài học.

## Không làm
Biểu đồ, so sánh giữa project, workspace (bước sau). Lượt bài học lỗi thì bỏ qua, không ảnh hưởng release.

## Cách khác đã cân nhắc
- Bảng DB mới cho bài học: bỏ, file markdown đủ dùng, anh sửa tay dễ, nằm cạnh nhật ký goal.
- Chạy bài học như một phiên (session) riêng: bỏ, chiếm khoá phiên; làn hỏi đáp đã chạy song song chỉ đọc.
