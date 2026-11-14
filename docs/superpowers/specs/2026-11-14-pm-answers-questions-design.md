# Để Finn (PM) trả lời câu hỏi thay anh – thiết kế

> Anh Zon yêu cầu 2026-11-14. Trạng thái: chờ anh duyệt.

## Mục đích

Khi Dev/QC hỏi anh, anh có thể giao cho PM trả lời thay ("Finn e trả lời luôn đi") thay vì tự trả lời từng câu. Bối cảnh: lệnh gõ vào ô Team đã tạo nhầm goal G2 (2026-11-14) vì ô Team luôn tạo goal mới.

## Cách làm

1. **Nút "Let Finn answer" / "Để Finn trả lời"** trên thẻ Questions (cạnh ô trả lời chung). Chỉ bấm được khi phiên đang dừng chờ anh.
2. Backend: route mới `POST /api/questions/delegate` (header `x-btm`, chỉ khi không có phiên chạy). Host chạy **một lượt PM** (ghế pm, agent đang ngồi ghế PM, có tính lượt) với prompt gồm: các câu hỏi đang mở, file ticket, báo cáo Dev/QC liên quan, quyền đọc code; PM **không sửa file**, chỉ in JSON `{"answers":[{"id":12,"answer":"…","needs_owner":false}]}`.
3. BTM ghi câu trả lời vào câu hỏi (kèm "(Finn trả lời)") cho các câu `needs_owner:false`; câu `needs_owner:true` vẫn mở chờ anh. Nếu không còn câu mở → tự Resume.
4. **Trung thực:** prompt dặn PM chỉ trả lời điều kiểm được từ repo/báo cáo; việc phải chạy trên Windows, mở cổng, xem bằng mắt thì `needs_owner:true` và ghi lý do. Không được viết "anh Zon đã kiểm".
5. **Chặn nhầm ở ô Command:** khi có câu hỏi đang mở mà anh gửi cho Team, hiện hộp hỏi lại: "Tin này sẽ tạo goal mới. Anh muốn trả lời câu hỏi, để Finn trả lời, hay vẫn tạo goal?" (hộp thoại kiểu agent đã có).

## Ngoài phạm vi

- PM không chạy test, không mở cổng, không sửa code trong lượt này.
- Không tự giao việc cho PM khi anh không bấm.

## An toàn

- Output PM không tin cậy: parse JSON chặt (zod), id phải là câu hỏi đang mở của đúng project, answer ≤ 2000 ký tự, bỏ ký tự điều khiển.
- PM sửa file trong lượt này → guard như lượt PM thường (pm_out_of_scope), không ghi câu trả lời.

## Để người làm tự quyết

Chữ trên nút, vị trí nút, cách hiện "(Finn trả lời)" trên dashboard.
