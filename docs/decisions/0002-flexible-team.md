# 0002 – Đội hình linh hoạt

- Ngày: 2026-11-09 · Người quyết: anh Zon · Ghi lại: Cheki

## Quyết định
1. Mọi ghế (PM, Dev, QC, Audit) gắn được với bất kỳ agent nào có ghế đó trong `can_sit`; một agent được kiêm nhiều ghế (vd Claude kiêm PM + Audit).
2. Agent = công cụ + model + tài khoản. Một công cụ có thể có nhiều agent với tài khoản khác nhau (vd thêm tài khoản Antigravity/Gemini làm Kai; Codex làm Kai).
3. Mỗi project có đội hình riêng (`team/project.yaml` `seats:`), ghi đè mặc định trong `btm.config.yaml`.
4. Giữ luật cứng: coder ≠ QC ticket đó, coder ≠ Audit goal đó; không API key; không tự đổi tài khoản.

Chi tiết: `docs/superpowers/plans/2026-11-09-btm-plan5-flexible-team.md`. Làm sau khi Plan 4 merge.
