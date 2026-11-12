# Review Plan 7 (Accounts) – vòng 1 – 2026-11-12

Reviewer độc lập (subagent), đọc diff `main...plan7-accounts`. Không thấy token lọt vào lỗi/log/ntfy/snapshot; UI dùng `textContent`, link chỉ https.

| # | Mức | Vấn đề | Xử lý |
|---|---|---|---|
| H1 | High | Gate chạy dưới user default của Worker, không phải tài khoản Dev vừa dùng → chạy lệnh dưới tài khoản đang ngủ | **Sửa:** `runGate` nhận `account_last:<agent>` |
| H2 | High | Snapshot đọc `.btm-status` dưới user default | **Sửa:** đọc dưới tài khoản đang chạy |
| M1 | Medium | Tài khoản claude/codex mới bật trước khi đăng nhập xong; lỗi "another login" để lại dòng; không có cách đăng nhập lại | **Sửa:** tạo tắt, bật khi đăng nhập thoát 0; đăng nhập khác đang chạy → 409 không tạo dòng; thêm `POST /api/accounts/:key/login` + nút Sign in |
| M2 | Medium | Tự Tiếp tục tối đa 2 lần/phiên không đủ cho a → b → c | **Sửa:** 2 + số tài khoản phụ đang bật |
| M3 | Medium | Thẻ ghế hiện energy/login của default; danh sách model ghi theo tài khoản nhưng đọc theo Worker | **Sửa:** thẻ ghế dùng tài khoản đang/sẽ chạy; model lưu theo Worker |
| L1 | Low | Wrapper root ghi vào home/workspace sót lại (symlink); usermod lỗi → kẹt | **Sửa:** từ chối khi còn đường dẫn cũ; `useradd -G` một lệnh |
| L2 | Low | Thiếu handler `error` cho tiến trình đăng nhập (sập BTM); hết giờ chỉ kill sudo | **Sửa:** handler error/EPIPE; hết giờ gọi `workerKillAll` |
| L3 | Low | Trùng mục trong cùng file import | **Sửa:** loại `duplicate in file` |
| L4 | Low | Hết tài khoản do relogin/ngủ vẫn báo `usage_limit_hit`; lệnh trực tiếp chỉ thử tài khoản đầu | **Sửa:** `no_usable_account:<agent>` (không tự Tiếp tục); lệnh trực tiếp thử lần lượt qua gate |

Còn để ý khi chạy thật (chưa kiểm được bằng test): đăng nhập claude qua `script` + dán mã; file agy dựng từ `{email, refresh_token}` được CLI làm mới token.
