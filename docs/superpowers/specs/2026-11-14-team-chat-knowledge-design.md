# Chat với team: hiểu ý tin nhắn + kho kiến thức + bàn kế hoạch với Finn – thiết kế

> Anh Zon yêu cầu 2026-11-14. Trạng thái: chờ anh duyệt. Liên quan: v2.0.0 meeting/phản biện (ghi ở `2026-11-14-agent-chat-bubbles-design.md`).

## Mục đích

1. Anh gõ một câu bất kỳ, BTM **hiểu đó là gì** (tiếp tục, hỏi, bàn kế hoạch, goal mới, project mới) thay vì dựa vào nút người nhận. Không bao giờ tạo goal khi anh chưa bấm xác nhận (bài học G2).
2. Team có **kho kiến thức chung**: lịch sử từng goal được nén lại, ai rảnh cũng trả lời được câu hỏi về việc cũ (Bruno bận thì người khác trích lục trả lời).
3. Anh **bàn với Finn** về job kế tiếp ngay cả khi người khác đang làm.

## Phần 1 – Phân loại tin nhắn

Ô Command thêm lựa chọn người nhận **Auto (mặc định)**; Team/PM/Dev/QC/Audit giữ nguyên cho ai muốn chỉ định.

Với Auto, BTM phân loại 2 tầng:

1. **Luật (không tốn lượt):**
   - đúng câu tiếp tục ("go ahead", "tiếp e"…) → Resume (đã có).
   - có "?" hoặc từ hỏi (gì, sao, nào, bao giờ, ở đâu, tới đâu, what, how, why, when, which…) và nhắc G<n>/ticket/tên agent hoặc "làm/đang" → **Hỏi**.
   - "kế tiếp", "tiếp theo", "next", "lên plan", "plan" → **Bàn kế hoạch**.
   - động từ giao việc ở đầu câu (làm, thêm, tạo, sửa, đổi, build, add, make, fix) và không có "?" → **Goal mới (nháp)**.
   - "project mới", "app mới", "new project" → **Project mới**.
2. **Không khớp hoặc khớp nhiều loại** → Finn hỏi lại bằng hộp thoại có 3 nút: "Trả lời câu hỏi" / "Lập goal mới" / "Chỉ ghi chú". Không gọi AI để đoán (rẻ, đoán sai ít hại).

Kết quả từng loại:

| Loại | Việc |
|---|---|
| Hỏi | Lượt trả lời **chỉ đọc** (Phần 2) |
| Bàn kế hoạch | Lượt PM **chỉ đọc**: Finn đề xuất 2–3 job kế tiếp (mỗi job: mục tiêu, lý do, ước số ticket) dựa trên kho kiến thức + goal đang mở. Hiện ở khung "Kế hoạch" với nút **Lập goal từ đề xuất này**. |
| Goal mới (nháp) | Finn tóm tắt lại (tên goal, phạm vi, dự kiến số ticket) → hộp **"Anh xác nhận tạo G<n> nhé?"** → anh OK mới gọi `start`. |
| Project mới | Hộp thông báo: project mới cần repo/thư mục mới (CLI `btm init`); ghi chú để làm họp khởi động v2.0.0. Không tạo gì. |

Tin nhắn và câu trả lời của chế độ Hỏi/Bàn kế hoạch hiện bằng bong bóng + một danh sách "Hỏi đáp" ngắn (10 câu gần nhất) dưới ô Command.

## Phần 2 – Kho kiến thức + ai rảnh trả lời

- **Nhật ký goal nén** `<data_dir>/knowledge/<KEY>/G<n>.md`, BTM tự viết (không AI) khi goal merge, vào thùng rác, hoặc anh bấm "Cập nhật kho" — gồm: tiêu đề, thời gian (giờ VN), từng ticket (trạng thái cuối, số vòng sửa, lý do trả về), hỏi–đáp với anh, kết quả audit + ticket sửa, release (tag/link), đường dẫn báo cáo. Tối đa ~4 KB/goal. Ngoài git, không release.
- **Lượt trả lời chỉ đọc**: prompt gồm câu hỏi + nội dung nhật ký các goal liên quan (dán thẳng vào prompt, worker không cần đọc data_dir) + quyền đọc repo. Agent trả lời ngắn, có dẫn ticket/file, nói rõ điều chưa kiểm được.
- **Ai trả lời**: người được nhắc tên/vai nếu đang rảnh; đang bận → người rảnh khác theo thứ tự PM → QC → Audit → Dev (bong bóng: "Bruno đang bận, để Finn trả lời giúp nhé"). Không ai rảnh → xếp hàng chờ người đầu tiên rảnh.
- Lượt trả lời không làm chậm việc đang chạy: chỉ chạy khi **ghế đó rảnh** và không chiếm lock phiên (một lượt nhẹ riêng, giới hạn 5 phút, tính vào lượt dùng của account đó).

## Phần 3 – Bàn kế hoạch với Finn khi Marry đang test

Lượt "Bàn kế hoạch" của Finn chạy song song được khi ghế PM rảnh (PM không ngồi ghế đang chạy). Nếu cùng account đang chạy (Finn ngồi cả PM lẫn QC), xếp hàng tới khi xong lượt QC.

> Điểm cần quyết khi làm: BTM hiện chạy **tuần tự 1 agent** (`max_parallel_agents: 1`). Phần 2–3 cần cho phép **một lượt chỉ đọc song song** với lượt đang chạy (khác account/worker, không đụng repo). Đây là thay đổi lớn nhất của thiết kế này.

## Ngoài phạm vi

- Phản biện nhiều vòng giữa các agent, biên bản họp (v2.0.0).
- Tạo project mới từ dashboard.

## An toàn

- Câu trả lời của agent là dữ liệu không tin cậy: textContent, cắt 2000 ký tự.
- Lượt chỉ đọc mà repo đổi → bỏ câu trả lời (như lệnh Audit/PM đã làm ở #92).
- Không bao giờ tạo goal / project mà không có cú bấm xác nhận của anh.

## Thứ tự làm đề xuất

1. Phân loại tin (luật + hộp hỏi lại) và Goal mới (nháp) có xác nhận. Không cần chạy song song.
2. Nhật ký goal nén + lượt trả lời chỉ đọc (tuần tự trước: chạy khi không có phiên chạy).
3. Cho phép lượt chỉ đọc chạy song song → "ai rảnh trả lời" + bàn kế hoạch khi team đang làm.
