# Agent chat bubbles – thiết kế

> Anh Zon yêu cầu 2026-11-14. Trạng thái: chờ anh duyệt.

## Mục đích

Dashboard sinh động hơn: các agent (Finn, John, Marry, Bruno…) và anh Zon "nói chuyện" bằng bong bóng thoại trên avatar mỗi khi giao việc, xong việc, hỏi đáp. Nhìn khu Agents là biết ai vừa giao gì cho ai, ai đang đợi ai.

## Nguyên tắc (anh Zon đặt)

- **Backend chuyển việc như cũ, không chờ hội thoại.** Hội thoại chỉ chạy ở giao diện, phát theo sau sự kiện đã xảy ra. Đóng dashboard thì không có thoại, việc vẫn chạy.
- **Người đang chạy lượt chỉ tập trung làm:** không nói, không có bong bóng trên avatar.
- Có nút tắt.

## Ngoài phạm vi

- Không sửa backend, không lưu thoại vào DB hay log, không gửi gì cho agent, không tốn lượt.
- Câu "anh Zon hỏi thăm" là thoại tự sinh cho sinh động, không phải lệnh.

## Cách làm

Làm hoàn toàn ở `web/index.html`. Mỗi lần nhận trạng thái mới (SSE), so với trạng thái trước để tìm sự kiện mới (ghế đổi người giữ, ticket đổi trạng thái, có câu hỏi mới, câu hỏi được trả lời, lỗi, Stop). Mở lại trang không phát lại chuyện cũ.

Cách khác đã cân nhắc: backend sinh thoại rồi đẩy xuống. Bỏ, vì phải sửa vòng chuyển việc (trái nguyên tắc) và dashboard đã có đủ sự kiện.

## Bong bóng

- Nổi trên avatar ở thẻ ghế (anh Zon: avatar góc trên "Zon · Owner"). Hiện khoảng 4 giây rồi mờ dần. Người đáp nói sau người hỏi khoảng 1,5 giây. Nhiều sự kiện dồn lại thì xếp hàng.
- **Mỗi nhân vật một kiểu bong bóng cố định**, bốc từ bộ khoảng 6 kiểu (màu viền/nền, dáng bo tròn, đám mây, góc vuông, vị trí đuôi) theo id của agent. Đổi tên hiển thị không đổi kiểu. Có cả light và dark.
- **Bong bóng chờ** "• • •" chớp chớp, chỉ trong lúc đợi phản hồi:
  - đã giao việc nhưng người nhận chưa bắt đầu lượt; lượt bắt đầu thì người nhận đáp một câu rồi bong bóng ẩn;
  - agent hỏi anh Zon: chớp trên avatar agent cho tới khi anh trả lời.
- Chữ trong bong bóng hiện bằng textContent. Nội dung lấy từ agent hoặc anh gõ thì cắt khoảng 80 ký tự.

## Thoại

Kho câu **tiếng Anh và tiếng Việt**, đổi theo nút EN/VI. Mỗi tình huống 5–6 câu, chọn ngẫu nhiên, không lặp câu vừa nói. Chèn tên hiển thị, mã ticket, giờ VN.

| Sự kiện | Nói | Đáp |
|---|---|---|
| Anh gửi Command cho Team | Zon (nội dung anh gõ, cắt ngắn) | cả team cùng lúc, mỗi người một câu |
| Anh gửi cho một ghế | Zon | người ở ghế đó |
| PM lập xong ticket | Finn: "John, GT-0005 is yours!" | Dev: "Ok anh Finn, em làm ngay!" |
| Dev xong, chuyển QC (câu kết) | John: "Mình dev xong rồi, Marry test nhé!" | Marry: "Ok John!" |
| QC passed | QC khen | Dev cảm ơn |
| QC trả về | QC: "Found a bug in GT-0005, back to you" | Dev: "Got it, fixing now!" |
| Agent hỏi anh | agent: "Anh Zon ơi, …" rồi bong bóng chờ | (đợi anh) |
| Anh trả lời | Zon (câu trả lời, cắt ngắn) | agent: "Thanks anh!" |
| Lỗi / timeout / Stop | agent than một câu | – |
| Audit / Release | Bruno / Finn | – |

### Hỏi thăm tiến độ

Khi có lượt đang chạy, khoảng 5–8 phút một lần (ngẫu nhiên), **anh Zon hoặc Finn** hỏi cả team hoặc một bạn cụ thể. **Người đang chạy không trả lời**, người rảnh trả lời thay:

1. Người vừa giao việc: "Em giao GT-0005 cho Marry test lúc 05:00 rồi anh."
2. Finn: "Để em check Marry làm tới đâu nhé" (bong bóng chờ khoảng 2 giây), rồi: "Marry đang test GT-0005 được 7 phút: *running npm test*." Phần cuối là dòng trạng thái thật trên thẻ, thời gian lấy từ giờ bắt đầu lượt.
3. Hỏi riêng một người rảnh: người đó nói về việc vừa làm, hoặc "Em đang rảnh, chờ việc ạ".
4. Finn đang chạy: một người rảnh khác check thay.

### Chuyện phiếm lúc rảnh

Người rảnh thỉnh thoảng nói chuyện vui với nhau (kho câu riêng, ví dụ "Coffee break?" / "Ai uống cà phê không?"), thưa: khoảng 10 phút một lần. Người đang chạy không tham gia. Không có phiên nào chạy thì cũng thưa như vậy.

## Nút tắt

Công tắc **Chat** ở đầu khối **Agents** (cạnh các ô Live / Waiting / Idle). Tắt thì không hiện bong bóng nào, kể cả bong bóng chờ. Lựa chọn được nhớ trong trình duyệt (localStorage, có try/catch).

## Để người làm tự quyết

Kiểu bong bóng cụ thể, thời gian hiện, nội dung từng câu trong kho.

## Giai đoạn sau (anh Zon 2026-11-14, ghi lại để làm sau, CHƯA làm)

Bản hiện tại: thoại chỉ cho vui, câu soạn sẵn, không gọi AI.

Sau này: khi anh Zon **bàn về project hay goal** (ví dụ trước khi chốt goal mới), các agent **phản biện nhau thật**: PM nêu cách chia việc, Dev nêu rủi ro kỹ thuật, QC nêu cách kiểm, Audit nêu rủi ro bảo mật; mỗi người đọc ý người trước rồi đồng ý hoặc phản bác, anh chốt.

Khác bản hiện tại ở chỗ: câu nói do AI sinh (tốn lượt/energy), cần backend (một phiên "thảo luận" riêng, không đụng vòng chuyển việc), có giới hạn số vòng và lưu lại kết luận cho PM dùng khi lập ticket. Cần thiết kế riêng (brainstorm) trước khi làm.
