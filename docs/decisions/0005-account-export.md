# 0005 – Export/import tài khoản dạng JSON trần

- Ngày: 2026-11-12 · Người quyết: anh Zon · Ghi lại: Cheki · Thiết kế: `docs/superpowers/specs/2026-11-12-accounts-design.md`

## Quyết định
- Dashboard export được **mọi tài khoản** của các Worker ra một file JSON (kể cả tài khoản đang ngủ), và import lại trên BTM ở máy khác. File chứa **nguyên văn file token OAuth** của từng CLI, không mã hoá (anh chọn JSON trần cho đơn giản).
- Đây là đường duy nhất BTM đọc nội dung token. Token không vào git, log, ntfy, snapshot/SSE hay thông báo lỗi.
- Không dùng API key (giữ nguyên `login.forbidden_env`).

## Cách làm an toàn
- Tạo user Linux cho tài khoản mới: root, chỉ qua `sudo -n /usr/local/bin/btm-account add <btm-user>` (sudoers đúng 1 lệnh; user đã tồn tại thì chỉ kiểm tra, không ghi gì vào home bằng root).
- Đọc/ghi file token: chạy **dưới chính user của tài khoản** qua `btm-worker-exec` (chỉ đụng home của nó; file 0600). Chỉ các file cố định theo công cụ:
  - claude-code: `.claude/.credentials.json`
  - codex-cli: `.codex/auth.json`
  - antigravity-cli: `.gemini/antigravity-cli/antigravity-oauth-token`
- Định dạng file agy (kiểm trên VM 2026-11-12, chỉ xem tên key): `{token: {access_token, token_type, refresh_token, expiry, expires_in}, auth_method, id_token_email}`. Nhập agy bằng `{email, refresh_token}` → dựng file với `access_token` rỗng, `expiry` đã qua để CLI tự làm mới.

## Giới hạn
- Ai có file export là dùng được mọi tài khoản trong đó: anh tự giữ file (không gửi qua chat/email, xoá khi xong).
- claude/codex đổi refresh token khi làm mới: cùng một tài khoản chạy trên 2 máy thì 1 máy sẽ bị đăng xuất. BTM báo ntfy khi tài khoản đang bật bị đăng xuất; không có khoá chung giữa các máy.
