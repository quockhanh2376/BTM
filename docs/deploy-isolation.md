# Triển khai cách ly agent (Plan 4.5)

Hai user: `agent` chạy BTM (code, `btm.db`, repo tin cậy) · `btm-worker` chạy mọi CLI agent và lệnh gate. Script: `deploy/isolation-setup.sh` (chạy bằng `admzon`).

## Bước 1 – prep (an toàn, làm ngay; service đang chạy không bị ảnh hưởng)
```bash
ssh -t admzon@100.96.250.103 "sudo bash /tmp/isolation-setup.sh prep"
```
Tạo user `btm-worker`, nhóm `btm-read`, `/srv/btm-repos`, `/opt/btm`, cài Claude Code + Codex (cùng bản) và agy cho worker, 2 wrapper `/usr/local/bin/btm-worker-exec|killall`, sudoers `/etc/sudoers.d/btm` (agent chỉ được chạy đúng 2 wrapper dưới btm-worker). Xem trước: thêm `--dry-run`.

## Bước 2 – đăng nhập 3 CLI dưới btm-worker (1 lần)
```bash
ssh -t admzon@100.96.250.103 "sudo -iu btm-worker claude auth login"
ssh -t admzon@100.96.250.103 "sudo -iu btm-worker codex login --device-auth"
ssh -t admzon@100.96.250.103 "sudo -iu btm-worker agy"
```
agy: làm theo hướng dẫn đăng nhập khi mở lần đầu, xong gõ `/quit`. Không dùng API key.
Kiểm: `ssh -t admzon@100.96.250.103 "sudo -iu btm-worker bash -lc 'claude auth status; codex login status; agy models | head -3'"`.

## Bước 3 – switch (Task 6, sau khi code Plan 4.5 merge)
Chuyển code BTM sang `/opt/btm`, `btm.service` `WorkingDirectory=/opt/btm`, giao `/srv/agent-projects` cho `btm-worker`, restart (anh đồng ý). Lệnh cụ thể sẽ có khi Task 6 xong.

## Quay lui
`sudo rm /etc/sudoers.d/btm /usr/local/bin/btm-worker-exec /usr/local/bin/btm-worker-killall` – BTM chạy lại như cũ (chưa bật `worker_user`). User `btm-worker` để lại vô hại (`sudo userdel -r btm-worker` nếu muốn xoá).
