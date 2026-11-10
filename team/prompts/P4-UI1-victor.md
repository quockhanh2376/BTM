# P4-UI1 · Dev · Nút "Dừng" + dashboard dày cho màn 27" 2K/4K

Scope: web/index.html, tests/web.test.ts. Không đổi logic/API.

1. **Đổi chữ** mọi chỗ "Dừng khẩn cấp" → "Dừng" (nút #stop-btn, confirm, feedback). Sửa test web.test.ts:213 theo chữ mới. Giữ id, class btn-danger, confirm.
2. **Dùng hết màn rộng.** Bỏ giới hạn `max-width: 1400px` của khung chính (dòng ~118) → full width, padding 2 bên ≤12px.
3. **Thu khoảng cách giữa thẻ:** gap/padding giữa các khối & thẻ (20/16px) → 8–10px; padding trong thẻ 16px → 10px. Không làm chữ nhỏ hơn hiện tại, không để chữ/nút chồng nhau.
4. **Lưới tự giãn:** lưới ghế (`repeat(3, 1fr)`, dòng ~350) → `repeat(auto-fill, minmax(280px, 1fr))`; lưới 2 cột (dòng ~698) giữ tỉ lệ nhưng ≥2560px cho thêm cột nếu có sẵn khối (không tạo khối mới). Màn hẹp (<900px) vẫn 1 cột như cũ.
5. Thanh energy vẫn canh đáy đều nhau (`.seat-footer {margin-top:auto}` – không phá).

Test: thêm test web.test.ts kiểm `max-width: 1400px` không còn và có `auto-fill`. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: team/reports/P4-UI1-dev.md (≤10 dòng).
