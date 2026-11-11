# Thiết lập đội hình (Plan 5)

## Thêm agent mới (ví dụ `kai` dùng agy)
1. Thêm agent vào `btm.config.yaml` mục `agents:`, gồm `tool`, `command`, `can_sit` và tuỳ chọn `model`, `effort`. Agent id phải viết thường, chỉ có chữ, số, `-`, `_`, vì nó sẽ thành tên user Linux `btm-kai`.
2. Trên VM, dùng `admzon` tạo user:
   ```bash
   sudo BTM_AGENTS="kai" bash /tmp/isolation-setup.sh prep
   ```
3. Đăng nhập đúng 1 CLI dưới user đó:
   ```bash
   ssh -t admzon@100.96.250.103 "sudo -iu btm-kai agy"
   ```
   Với Claude dùng `claude auth login`; với Codex dùng `codex login --device-auth`.
4. Khởi động lại `btm`. Dashboard, mục Tài khoản, phải hiện đèn đăng nhập "Ổn" cho agent mới.

Nếu thiếu user Linux, đèn hiện "cần đăng nhập" kèm lệnh tạo user.

## Model và mức suy luận
- Mặc định: model mặc định của CLI, effort `medium`.
- Đổi trên dashboard, mục Tài khoản → Lưu. Thay đổi áp dụng từ lượt kế tiếp. Khi đang có lượt chạy thì không đổi được.
- Codex chỉ có effort low, medium, high.

## Ai ngồi ghế nào
Thứ tự ưu tiên, cao nhất trước:
1. Đổi ghế trên dashboard (lưu theo project).
2. `team/project.yaml` `seats:`, chỉ đọc từ nhánh `main`. Agent sửa file này ở nhánh làm việc thì không có tác dụng.
3. `seats:` trong `btm.config.yaml`.

Override không hợp lệ (agent lạ, hoặc không có ghế đó trong `can_sit`) bị bỏ qua và hiện cảnh báo "Đội hình: …" trên dashboard.

Ví dụ `team/project.yaml`:
```yaml
key: GTM
seats:
  pm: elon
  audit: elon     # Claude kiêm PM + Audit
```

## Kiêm nhiệm
- **Được:** PM + QC, PM + Audit, Dev ở ticket này + QC ở ticket khác.
- **Không được:**
  - người code một ticket thì không QC ticket đó;
  - người code bất kỳ ticket nào của goal thì không Audit goal đó.

  BTM chặn hai trường hợp này: phiên dừng, hoặc chuyển sang người dự phòng.

## Hết Energy
- `seats_backup` khai báo người ngồi thay cho từng ghế, theo thứ tự. Người chính hết Energy hoặc mất đăng nhập thì người kế tiếp còn Energy ngồi thay, miễn không vi phạm luật cứng.
- Không còn ai thì phiên dừng với `all_agents_exhausted`, kèm lý do của từng người.
- Lượt đang chạy mà agent báo hết hạn mức thì BTM ghi agent đó hết tới giờ hồi và tự Tiếp tục (tối đa 2 lần/phiên) bằng người dự phòng.
- `seats_backup` đặt được theo project trong `team/project.yaml` (đọc từ `main`). Nếu có, nó ghi đè giá trị trong `btm.config.yaml`.
  ```yaml
  seats_backup:
    dev: [jenny]
    qc: [elon]
  ```
