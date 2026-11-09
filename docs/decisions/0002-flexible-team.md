# 0002 – Đội hình linh hoạt

- Ngày: 2026-11-09 · Người quyết: anh Zon · Ghi lại: Cheki

## Quyết định
1. Mọi ghế (PM, Dev, QC, Audit) gắn được với bất kỳ agent nào có ghế đó trong `can_sit`; một agent được kiêm nhiều ghế (vd Claude kiêm PM + Audit).
2. Agent = công cụ + model + tài khoản. Một công cụ có thể có nhiều agent với tài khoản khác nhau (vd thêm tài khoản Antigravity/Gemini làm Kai; Codex làm Kai).
3. Mỗi project có đội hình riêng (`team/project.yaml` `seats:`), ghi đè mặc định trong `btm.config.yaml`.
4. Giữ luật cứng: coder ≠ QC ticket đó, coder ≠ Audit goal đó; không API key; không tự đổi tài khoản.

Chi tiết: `docs/superpowers/plans/2026-11-09-btm-plan5-flexible-team.md`. Làm sau khi Plan 4 merge.

## Ghi chú tương lai
Anh Zon có thể cho phép API key (vd Gemini) sau này. Plan 5 vẫn cấm, nhưng `account_env` phải cho phép thêm dạng giá trị `{ secret: <tên> }` mà không đổi cấu trúc. Bảo vệ dự kiến: giới hạn tại provider (API + IP VM + ngân sách), secret ngoài git (systemd `LoadCredential`), cấp key đúng agent đúng lượt, quét rò rỉ ở gate + che trong log/dashboard, nút tắt key. Sẽ có decision 0003 khi bật.

### Mô hình tài khoản anh Zon chốt (2026-11-09)
Ví dụ đội: 1 tài khoản Claude (đăng nhập), 1 tài khoản Codex (đăng nhập), 1 API key Gemini, 1 API key Z.ai (GLM).
Luật: **1 API key ↔ đúng 1 agent, 1 agent ↔ tối đa 1 key**, không bao giờ 2 agent dùng chung key hay 1 agent cầm 2 key.
- Kiểm khi load config (tham chiếu secret là duy nhất) + lúc chạy (key chỉ vào env của agent đó trong lượt đó; v2 song song thêm khoá theo secret).
- `forbidden_env` đổi nghĩa: cấm trong env chung của service; chỉ Core được tiêm key cho đúng agent.
- Energy của agent dùng key = chi tiêu / ngân sách anh đặt.
- Cần xác minh khi làm: Z.ai chạy qua Claude Code (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` của Z.ai)?; Gemini API key chạy bằng CLI nào (agy có nhận key không).
