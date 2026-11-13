# 0006 – Core đẩy code lên GitHub bằng deploy key

- Ngày: 2026-11-13 · Người quyết: anh Zon · Ghi lại: Cheki · Thiết kế: `docs/superpowers/specs/2026-11-13-goal-release-design.md`

## Quyết định
- Sau khi anh Approve và goal merge vào `main`, **core** (không phải agent) push `main` và tag `v<version>` lên repo GitHub của project.
- Credential: **deploy key** SSH, mỗi repo một khoá, quyền ghi chỉ vào đúng repo đó. Không dùng API key hay token (giữ `login.forbidden_env`).
- Khoá nằm ở `/var/lib/btm/keys/<project-key>` (user `agent`, 0600; `/var/lib/btm` để 700 nên agent không đọc được). `known_hosts` của github.com ghim trong `/var/lib/btm/keys/known_hosts`.
- Không force-push, không xoá nhánh/tag trên GitHub. Push lỗi thì code vẫn ở `main` trên VM; dashboard báo `push_failed`, ntfy báo, anh bấm Push lại.
- Repo test đầu tiên: `quockhanh2376/GameTest-BTM` (public, anh tự xoá sau). Repo chỉ chứa code của goal.

## Giới hạn
- Ai có file khoá thì ghi được vào repo đó (chỉ repo đó). Xoá repo hoặc gỡ deploy key trên GitHub là thu hồi.
- Nội dung push là code do agent viết: audit (Bruno) phải pass trước khi Approve, để không đẩy secret lên repo public.
