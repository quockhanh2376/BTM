# 0003 – Master BTM (MB): một API key Z.ai làm người dự phòng chung

- Ngày: 2026-11-14 · Người quyết: anh Zon · Ghi lại: Cheki · Trạng thái: **ĐÃ DUYỆT** (anh Zon 2026-11-14, duyệt cả thiết kế)
- Thiết kế: `docs/superpowers/specs/2026-11-14-master-btm-design.md`

## Quyết định
- Gỡ luật "BTM không dùng API key" **chỉ cho đúng một key**: key Z.ai (gói Max) của agent **MB (Master BTM)**.
  Mọi agent khác vẫn đăng nhập bằng tài khoản, `login.forbidden_env` giữ nguyên với chúng.
- MB đứng trong danh sách dự phòng của mọi ghế (PM, Dev, QC, Audit): ghế nào hết quota thì MB vào thay ngay.
- MB chọn được model mặc định và đổi model trên dashboard như các agent khác.
- Một key ↔ đúng một agent (MB). Không dùng chung, không đưa cho agent khác.
- MB có ID `mb`, tên hiển thị "Boss", và là worker như mọi agent: không thêm quyền, vẫn qua gate / QC / audit.

## Bảo vệ key
1. **Agent không bao giờ cầm key thật.** BTM chạy một cổng trung gian nội bộ (127.0.0.1) giữ key; lượt của MB chỉ nhận địa chỉ cổng + mã tạm của lượt đó. Hết lượt, mã tạm hết hạn.
2. **Mã hoá trong DB:** AES-256-GCM. Khoá giải mã nằm trong file riêng (0600, chỉ service BTM đọc, nạp qua systemd), không nằm trong DB, không trong git.
3. **Nhập key:** anh tự dán vào Settings trên dashboard (chỉ một lần). Không qua chat, không qua git, Cheki không thấy key. Dashboard chỉ hiện 4 ký tự cuối.
4. **Không lộ ra ngoài:** API không bao giờ trả key; log, dashboard, báo cáo che mọi chuỗi giống key; gate chặn commit có key.
5. **Tắt khẩn cấp + đổi key:** một nút tắt MB ngay (cổng trung gian từ chối mọi yêu cầu); đổi key = dán key mới.

## Giới hạn (anh Zon đã chấp nhận 2026-11-14)
- Mã hoá chống lộ khi DB bị copy, backup hay export. Người có quyền root trên VM vẫn đọc được key. Anh giữ quyền root.
- Z.ai trả phí theo gói Max: dùng hết hạn mức của gói thì MB cũng dừng như các agent khác.

## Trước khi code
- Thử thật trên VM: Claude Code chạy model GLM qua cổng tương thích Anthropic của Z.ai (một lượt nhỏ, project test).
