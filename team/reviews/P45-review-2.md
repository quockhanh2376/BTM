# P45 review 2 – vòng sửa E1–E10 (99da565..)

Reviewer độc lập (chỉ đọc code). Tóm tắt + xử lý của Cheki.

| # | Mức | Vấn đề | Xử lý |
|---|---|---|---|
| H1 | High | Lệnh worker không có timeout. `.git/config`, `info/attributes` và `~/.gitconfig` của agent (filter, gpg) chạy lúc import, làm treo BTM hoặc sinh tiến trình sau killall. FIFO ở `.btm-last.out` làm `head` treo | Đã sửa: timeout mọi lệnh worker; `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgSign=false`; xoá config + attributes rồi `git init` trước `add`; killall sau import và readOut; readOut chỉ đọc file thường |
| H2 | High | cron/at/linger sống qua killall | Đã sửa: `cron.deny`, `at.deny`, `loginctl disable-linger` |
| M1 | Med | Cùng agent đổi ghế (Dev → QC) dùng chung home bị sửa | Để Plan 5 (dựng lại config từ mẫu root); ghi trong runbook |
| M2 | Med | Gate chạy với node_modules/home của Dev | Giới hạn đã ghi; để plan sau (`npm ci` trên checkout sạch) |
| M3 | Med | `btm isolate` clone mất nhánh goal | Đã sửa: fetch `+refs/heads/*` sau clone |
| M4 | Med | Repo lồng → mọi lượt sau `bundle_unsafe` | Đã sửa: `clean -ffd` |
| E7 | – | Gate sync không killall trước | Đã sửa |
| E8 | – | Kiểm tiền tố thiếu dấu `/` | Đã sửa |
| L1 | Low | killall hết 10 vòng vẫn thoát 0 | Đã sửa: thoát 3 → BTM báo lỗi |
| L2 | Low | Bundle cả lịch sử mỗi lượt (giới hạn 1 GiB) | Để sau |
| L3 | Low | fetch bundle không fsck | Để sau |
| L4 | Low | node phải ở `/usr/bin`; agy là file đơn | Kiểm khi chạy prep trên VM |
| L5 | Low | `/home/<user>` và `/srv/btm-work` cố định trong wrapper | Để sau (config mặc định khớp) |

Các phần đã kiểm và ổn:
- sudoers chỉ cho 2 wrapper, chạy dưới `%btm-workers`.
- Wrapper dùng `env -i` và PATH cố định.
- Guard Plan 4 xử lý được import non-fast-forward.
- Thư mục bundle tạm là 0700 do BTM sở hữu.
