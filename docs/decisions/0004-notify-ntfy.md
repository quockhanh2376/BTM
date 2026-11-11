# 0004 – Thông báo qua ntfy

- Ngày: 2026-11-11 · Người quyết: anh Zon · Ghi lại: Cheki

## Quyết định
- BTM báo anh qua **ntfy**, không dùng Telegram. Mặc định báo khi phiên cần anh xử lý (`needs_owner`, gồm cả hết Energy và `all_agents_exhausted`), khi goal chờ duyệt, và khi hết lượt.
- Địa chỉ topic (`https://ntfy.sh/<topic khó đoán>`) là bí mật. Nó nằm trong file `/var/lib/btm/notify.url` (user `agent`, quyền 0600), không đưa vào git, log hay dashboard. Agent không đọc được file này, vì `/var/lib/btm` để quyền 700.
- Tin nhắn chỉ theo mẫu cố định: `BTM <project>`, `<nhãn> · <mã lý do>`, kèm link dashboard. Không chép chữ tự do của agent.
- Gửi lỗi thì phiên vẫn chạy bình thường. Cùng một sự kiện chỉ gửi 1 lần trong 10 phút.

## Giới hạn
- Ai biết tên topic thì đọc được tin, nên topic phải dài và ngẫu nhiên. Tin không chứa code hay bí mật.
- Link dashboard chỉ mở được khi tunnel SSH đang chạy.
