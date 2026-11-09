# P4-T9 · fix 2 · Victor · Bảng ticket vỡ cột

Cheki mở dashboard thật với dữ liệu mẫu: bảng ticket vỡ cột. Đo trên trình duyệt: `<th>` rộng 72/315/80/96px nhưng `<td>` chỉ 69/80/19/19px → cột "Mục tiêu" bị bóp, chữ xuống dòng từng từ.

**Nguyên nhân:** `.ticket-row { display: flex }` (web/index.html ~dòng 1165) biến `<tr>` thành flex và `<td>` thành block → bảng không còn theo `<colgroup>`.

**Sửa:**
1. Bỏ `display: flex` (và mọi thuộc tính flex) khỏi `.ticket-row`; giữ `cursor: pointer`, hover, focus. Dòng lịch sử mở ra dưới ticket phải là một `<tr>` có 1 `<td colspan="4">`.
2. Ô "Mục tiêu" bỏ lặp Ticket ID (đã có cột ID): hiển thị `#<number>/<of> · <tiêu đề>` + chip type/size. Sửa test tương ứng.
3. Thêm test web: CSS không đặt `display: flex|grid|block` cho `.ticket-row` hay `td` trong bảng ticket.

Scope: web/index.html, tests/web.test.ts. Không giảm số test (hiện 69).
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (15 Windows).
Báo cáo: ghi đè team/reports/P4-T9-dev.md (ngắn).
