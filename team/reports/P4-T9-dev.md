# P4-T9 fix 2: Bảng ticket vỡ cột

- Bỏ `display: flex` và các thuộc tính flex khỏi `.ticket-row`; giữ `cursor: pointer`, hover, focus. Bảng ticket tuân thủ chính xác `<colgroup>` (72px / auto / 80px / 96px).
- Dòng lịch sử là `<tr>` với 1 `<td colspan="4">`.
- Cột "Mục tiêu" bỏ lặp Ticket ID: hiển thị `#<number>/<of> · <tiêu đề>` kèm chip type/size.
- Thêm test web kiểm tra CSS không đặt `display: flex|grid|block` cho `.ticket-row` hay `td`.
- Số test web: 69 → 70 test.
- `npx tsc --noEmit` sạch; `npx vitest run` không tăng lỗi (15 baseline Windows).
