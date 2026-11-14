# Thùng rác goal – thiết kế

> Anh Zon yêu cầu 2026-11-14. Trạng thái: chờ anh duyệt.

## Mục đích

Dọn goal cũ hoặc tạo nhầm (vd G2 sinh ra từ một câu chat) để làm goal mới, **không mất dữ liệu nếu xoá nhầm**. Lần gỡ G2 bằng tay (đặt phiên thành `refused`) cho thấy cần tính năng thật: dashboard vẫn coi phiên của goal đã bỏ là phiên hiện tại, nút Resume/"tiếp e" chọn nhầm.

## Cách làm

1. **Nút ✕ ở góc phải tiêu đề mỗi goal** trên bảng Goals. Bấm → hộp thoại kiểu agent hỏi lại: "Move G2 to Trash? Tickets and its branch are kept. You can restore it." Nút **Keep** (mặc định) / **Move to Trash**.
2. **Vào thùng rác (xoá tạm)**:
   - Goal có cờ `archived_at` (+ lý do), giữ nguyên `state` cũ để khôi phục đúng.
   - Mọi phiên đang dừng của goal (needs_owner / stopped / out_of_turns / awaiting_approval) → `refused`, ghi note "goal archived".
   - Ẩn khỏi bảng Goals, khỏi "Active goals", và **snapshot/Resume bỏ qua phiên của goal đã lưu trữ** (sửa luôn lỗi dashboard hiện phiên #16).
   - Câu hỏi đang mở của goal → `used` (không còn hiện).
   - Không đụng git, ticket, lịch sử.
   - Chặn khi goal đang có phiên chạy (409). Goal đã `merged`: chỉ ẩn, không đụng gì khác.
3. **Thùng rác**: link "Trash (n)" ở chân bảng Goals mở danh sách goal đã lưu trữ (tiêu đề, số ticket, ngày xoá). Mỗi dòng:
   - **Restore**: bỏ `archived_at`, goal về state cũ; nếu goal chưa xong thì tạo một phiên `needs_owner` cho goal (như "trả ticket về Dev") để anh bấm Resume là chạy tiếp.
   - **Delete permanently**: hỏi lần hai ("không hoàn tác được trên dashboard"). Trước khi xoá, BTM ghi **bản sao lưu** `<data_dir>/trash/<KEY>/G<n>-<giờ>/` gồm `goal.json` (goal, ticket, lịch sử ticket, câu hỏi, phiên) và `branch.bundle` (git bundle nhánh goal). Sau đó xoá các dòng DB của goal và xoá nhánh goal trong checkout tin cậy. **Không bao giờ đụng main, nhánh khác hay GitHub.** Số goal (n) không dùng lại.
4. **API** (header `x-btm`, không cho khi có phiên chạy): `POST /api/goals/:n/archive`, `POST /api/goals/:n/restore`, `POST /api/goals/:n/purge`, `GET /api/goals/trash`.

## Ngoài phạm vi

- Không tự xoá theo thời gian (chỉ khi anh bấm).
- Không có nút khôi phục từ bản sao lưu trên dashboard (Cheki khôi phục bằng tay nếu cần).
- Không xoá nhánh đã push lên GitHub.

## Kiểm thử chính

- Archive G2 → không hiện trên bảng, Resume chọn phiên của G1, snapshot không lấy phiên G2.
- Archive goal đang chạy → 409.
- Restore → goal về state cũ, có phiên needs_owner, Resume chạy tiếp.
- Purge → có `goal.json` + `branch.bundle`, DB không còn goal/ticket, nhánh goal mất, main không đổi; purge goal G1 không đụng G2.
