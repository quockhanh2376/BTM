# T-002 · Qeen
## Bug

- `src/config.ts:127`: `seats.pm: toString` lấy thuộc tính kế thừa từ `agents`, gây `TypeError` tại `.includes()` thay vì `ConfigError` (đã tái hiện). Kiểm tra own-property và thêm test hồi quy.

## Cần sửa

- `tests/config.test.ts`: thiếu test từ chối `max_parallel_agents: 2` theo Global Constraints và khóa lạ ở root/nested theo yêu cầu `.strict()`.

## Cần xác nhận

- Chưa chạy Vitest vì sandbox chỉ đọc, test cần tạo file tạm; `tsc --noEmit` đã pass.