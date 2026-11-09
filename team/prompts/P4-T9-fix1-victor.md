# P4-T9 · fix 1 · Victor · Khôi phục tab truy cập được + test web

P4-T9 đúng hướng nhưng làm mất tính năng cũ của 5 tab trạng thái (prompt yêu cầu GIỮ): không còn `role="tablist"`, không còn điều hướng phím ← → (vòng tròn), mất `<colgroup>` cố định độ rộng cột; và xoá 18 test web.

**Làm:**
1. Trong MỖI nhóm goal: 5 tab có `role="tablist"` / `role="tab"` + `aria-selected` + `aria-controls` / `role="tabpanel"`; phím ← → đổi tab vòng tròn và chuyển focus; tab active mặc định = tab có ticket đang chạy, không có thì tab đầu tiên có ticket, giữ lựa chọn của anh tới khi trạng thái đổi (như bản cũ).
2. Bảng ticket: `table-layout: fixed` + `<colgroup>` với độ rộng cột cố định (cột #/ID hẹp, tiêu đề rộng, vòng sửa, cập nhật); trống ghi "Không có ticket".
3. Viết lại cho layout goal MỖI test cũ dưới đây (bản cũ: `git show HEAD:tests/web.test.ts`), giữ ý và ngưỡng (vd tương phản ≥ 4.5:1). Chỉ bỏ test nào mà yêu cầu đó thật sự không còn – ghi tên + lý do vào báo cáo.

**Scope:** web/index.html, tests/web.test.ts. Giữ `.seat-footer { margin-top: auto; }`.
**Xong khi:** web.test.ts ≥ 63 test; `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).
**Báo cáo:** ghi đè team/reports/P4-T9-dev.md, ngắn: dòng 1 số test web trước → sau; test bỏ + lý do; Bug nếu có.

## 18 test web bị xoá
- CSS: tab dạng thẻ hồ sơ (bo góc trên ~12px, chồng lên nhau nhẹ), tab active nổi cao hơn, nền accent, không viền giữa
- bảng trong panel giữ nguyên và dòng Không có thẻ nằm trên cùng panel
- bảng trong panel: table width 100%, table-layout fixed, có colgroup và đặt đúng độ rộng các cột
- có cấu trúc ARIA tablist/tab/tabpanel và đầy đủ 5 tab kèm số đếm
- cả 5 tab đều mang thuộc tính data-state tương ứng với trạng thái
- hàng chứa 2 khung dùng align-items: stretch
- hỗ trợ điều hướng phím ← → đổi tab với vòng lặp tuần hoàn
- khi xếp dọc ở màn hẹp vẫn giữ min-height 360px
- khung Bảng task là flex column
- mặc định tab active theo thẻ đang chạy, fallback tab đầu tiên có thẻ, giữ lựa chọn người dùng cho đến khi trạng thái thay đổi
- panel bên dưới là bảng chữ ID · Mục tiêu · Vòng sửa · Cập nhật, mục tiêu xuống dòng, trống ghi 
- panel bên dưới tab có flex: 1 và min-height 360px để luôn kéo dài xuống đáy khung
- renderTaskTable hiển thị đúng các cột ID, Mục tiêu, Vòng sửa, Cập nhật và trạng thái trống 
- tab active có nền đặc màu riêng và đường viền nối panel cùng màu đó
- tab không active có dải màu riêng 3px ở mép trên và số đếm có màu riêng
- định nghĩa 5 biến màu trạng thái cho cả 2 theme (:root và [data-theme=
- độ tương phản chữ trên cả 2 theme đều đạt >= 4.5:1 cho cả tab active và không active
- độ tương phản chữ trên nền tab active và số đếm trên cả 2 theme đều đạt >= 4.5:1
