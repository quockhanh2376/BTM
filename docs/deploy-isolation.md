# Triển khai cách ly agent (Plan 4.5)

User `agent` chạy BTM (code, `btm.db`, checkout tin cậy). Mỗi agent một user riêng: `btm-elon` (Claude), `btm-jacky` (agy), `btm-jenny` (Codex). CLI dùng chung ở `/opt/btm-cli`, do root sở hữu. Workspace của agent: `/srv/btm-work/btm-<agent>/<project>`. Lệnh gate chạy dưới user của Dev của ticket. Script: `deploy/isolation-setup.sh`, chạy bằng `admzon`.

## Bước 1 – prep (an toàn; service đang chạy không bị ảnh hưởng)
```bash
scp deploy/isolation-setup.sh admzon@100.96.250.103:/tmp/
ssh -t admzon@100.96.250.103 "sudo bash /tmp/isolation-setup.sh prep"
```
Bước này tạo:
- nhóm `btm-read` (đọc checkout tin cậy) và `btm-workers` (đích sudo)
- 3 user `btm-<agent>`
- `/srv/btm-repos` và `/srv/btm-work/<user>` (700)
- `/opt/btm-cli`, chứa Claude Code, Codex và agy
- 2 wrapper `/usr/local/bin/btm-worker-exec|killall`
- `/etc/sudoers.d/btm`: `agent` chỉ được chạy đúng 2 wrapper đó, dưới user thuộc nhóm `btm-workers`

Muốn xem trước thì thêm `--dry-run`.

## Bước 2 – đăng nhập: mỗi user chỉ đăng nhập đúng CLI của mình (1 lần)
```bash
ssh -t admzon@100.96.250.103 "sudo -iu btm-elon claude auth login"
```
```bash
ssh -t admzon@100.96.250.103 "sudo -iu btm-jacky agy"
```
```bash
ssh -t admzon@100.96.250.103 "sudo -iu btm-jenny codex login --device-auth"
```
- agy: làm theo hướng dẫn đăng nhập khi mở lần đầu, xong gõ `/quit`.
- Không dùng API key.

Kiểm tra:
```bash
ssh -t admzon@100.96.250.103 "sudo -iu btm-elon claude auth status; sudo -iu btm-jenny codex login status; sudo -iu btm-jacky bash -lc 'agy models | head -3'"
```

## Bước 3 – switch (sau khi code Plan 4.5 merge; anh đồng ý restart)
1. Dừng service và chạy switch:
   ```bash
   ssh -t admzon@100.96.250.103 "sudo systemctl stop btm && sudo bash /tmp/isolation-setup.sh switch"
   ```
   Switch đặt `/var/lib/btm` về 700 và thêm `UMask=0027` cho `btm.service`.
2. Trong `btm.config.yaml` trên VM, bỏ comment 3 dòng `worker_prefix: btm-`, `trusted_root: /srv/btm-repos`, `work_root: /srv/btm-work`.
3. Sao lưu DB:
   ```bash
   sudo -u agent cp /var/lib/btm/btm.db /var/lib/btm/btm.db.bak-isolate
   ```
   Sau đó, dưới user `agent`, chạy `btm isolate`. Lệnh này tạo checkout tin cậy, kiểm `main` khớp sha đã ghim, rồi chuyển goal/ticket/session sang đường dẫn mới.
4. Khởi động lại:
   ```bash
   sudo systemctl start btm
   ```

## Giới hạn còn lại
- Lệnh gate chạy với `node_modules` trong workspace của Dev, mà Dev sửa được thư mục này.
- Muốn chặn hẳn thì gate phải chạy trên checkout sạch và chạy `npm ci`. Việc này để plan sau.
- Cùng một agent ngồi ghế khác (vd jenny làm Dev ticket A rồi QC ticket B) vẫn dùng chung home của mình. Cấu hình CLI mà jenny sửa lúc làm Dev còn nguyên khi jenny làm QC. Cách sửa: dựng lại cấu hình từ mẫu của root trước mỗi lượt, chỉ giữ phần đăng nhập. Việc này để Plan 5.
- File đã có sẵn trong repo trước khi cách ly không được kiểm tra symlink.

## Quay lui
1. Comment lại 3 dòng config.
2. Dừng service rồi chép `btm.db.bak-isolate` đè lên `btm.db`.
3. Xoá các file:
   ```bash
   sudo rm /etc/sudoers.d/btm /usr/local/bin/btm-worker-exec /usr/local/bin/btm-worker-killall /etc/systemd/system/btm.service.d/isolation.conf
   ```

User `btm-worker` của bản prep cũ không còn dùng nữa. Muốn xoá thì chạy:
```bash
sudo userdel -r btm-worker
```
