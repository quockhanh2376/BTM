# BTM – Kho lưu trữ chữ và ảnh của anh Zon (attachments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Trạng thái:** để review, **chưa làm**. Anh Zon yêu cầu ghi lại 2026-11-13 để khỏi quên. Làm khi anh bảo.
>
> **Cách chạy:** như các plan trước: Cheki làm từng task trên nhánh riêng, test VM ×3, tự merge. Deploy hỏi anh, chỉ deploy khi không có phiên chạy.

**Goal:** Mọi thứ anh Zon đưa vào BTM (ghi chú Team note, ảnh dán ở Command, ảnh kèm câu trả lời) nằm ở **một kho riêng ngoài git, mỗi project một thư mục** `<data_dir>/attachments/<KEY>/`, có hạn giữ, có backup và **xoá được cả thư mục của một project**.

**Architecture:** Một module `src/storage/attachments.ts` lo đường dẫn, ghi, đọc, liệt kê và xoá. Các chỗ đang ghi file (Team note → `team/inbox/`, ảnh trả lời → `.git/btm-answers/`) chuyển sang module này. Agent vẫn nhận đường dẫn tuyệt đối (prompt + `-i`), y như ảnh Team note hiện nay.

**Tech Stack:** như các plan trước. Không thêm dependency.

## Hiện trạng (2026-11-13)

| Loại | Đang nằm ở | Vấn đề |
|---|---|---|
| Câu hỏi + câu trả lời (chữ) | Bảng `questions` trong `btm.db` | Giữ mãi, không dọn |
| Ảnh kèm câu trả lời | `.git/btm-answers/Q-<id>.<ext>` trong checkout project | Ngoài git (tốt), nhưng xoá checkout là mất; không backup |
| Team note (`N-<id>.md`) + ảnh Command | **Commit vào git** ở `team/inbox/` | Đi theo nhánh goal vào main, rồi **lên GitHub khi release**. Nút xoá inbox chỉ xoá khỏi main, lịch sử git vẫn còn |
| Log lượt chạy | Thư mục log trong `data_dir` | Tăng dần, không giới hạn (ngoài phạm vi plan này, ghi để nhớ) |

## Global Constraints

- Kho nằm ở `<data_dir>/attachments/<KEY>/` (`KEY` = project key, `/^[A-Z]{2,5}$/`). Tên file chỉ dạng `N-<id>.md`, `N-<id>.<png|jpg|webp>`, `Q-<id>.<png|jpg|webp>`. Từ chối symlink, từ chối tên lạ.
- **Không bao giờ vào git, không bao giờ lên GitHub.**
- `data_dir` còn chứa deploy key và DB: worker **không** được đọc `data_dir`. Chỉ thư mục `attachments` cho worker đọc (quyền riêng, xem Task 1). Không nới quyền `keys/`.
- Xoá chỉ làm khi anh bấm, có hỏi xác nhận, ghi một dòng log. Không xoá tự động ảnh của goal chưa merge.
- Không đổi luồng hiện có: agent vẫn đọc ghi chú và ảnh như cũ, chỉ đường dẫn đổi.

## Review Focus

1. **Worker đọc được ảnh nhưng không đọc được `keys/`** → test quyền thư mục (Task 1).
2. **Xoá project A không đụng project B** → test `purgeProject('GT')` để nguyên `MG/` (Task 4).
3. **Dọn theo hạn giữ không xoá ảnh goal đang làm** → test (Task 3).
4. **File cũ ở `team/inbox/` và `.git/btm-answers/`** → vẫn đọc được (đọc chỗ cũ nếu kho mới không có), không mất dữ liệu (Task 2).
5. **Đĩa đầy / ghi lỗi** → trả lỗi rõ cho dashboard, không tạo câu trả lời thiếu ảnh (Task 2).

---

### Task 1: Module kho + quyền thư mục

**Files:** Create `src/storage/attachments.ts`; test `tests/attachments.test.ts`; Modify `docs/isolation-setup` (hoặc `isolation-setup.sh`) cho quyền thư mục.

- `attachmentPath(cfg, key, name): string` (kiểm tên + chặn symlink), `saveAttachment(cfg, key, name, bytes)`, `listAttachments(cfg, key): { name, bytes, mtime }[]`, `removeAttachment(cfg, key, name)`, `purgeProject(cfg, key): { removed: number; bytes: number }`.
- Quyền: `attachments/` 0750, nhóm = nhóm chung của các worker (anh chốt tên nhóm khi làm, mặc định `btm-workers`); file 0640. `data_dir` và `keys/` giữ nguyên quyền.
- [ ] Test: tên lạ / `..` / symlink → lỗi; lưu rồi đọc lại; `purgeProject('GT')` chỉ xoá `GT/`.

### Task 2: Chuyển nơi ghi sang kho

**Files:** Modify `src/server/http.ts` (answer + team-note), `src/core/session.ts` (đường dẫn prompt + `images`), `src/server/inbox.ts`; tests `tests/http.test.ts`, `tests/session.test.ts`.

- Team note mới: `N-<id>.md` + ảnh ghi vào kho, **không commit vào `team/inbox/`**. Prompt PM đưa đường dẫn tuyệt đối trong kho.
- Ảnh trả lời: ghi vào kho thay vì `.git/btm-answers/`.
- Đọc: kho trước, không có thì chỗ cũ (`team/inbox/`, `.git/btm-answers/`), để dữ liệu cũ vẫn dùng được.
- [ ] Test: note mới không tạo commit nào; prompt và `images` trỏ vào kho; dữ liệu cũ vẫn đọc được.

### Task 3: Hạn giữ và giới hạn dung lượng

**Files:** Modify `src/config.ts` (`attachments: { keep_days: 30, max_mb: 500 }`), `src/server/serve.ts` (dọn lúc khởi động + mỗi 24 giờ); test `tests/attachments.test.ts`.

- Xoá file của goal **đã merge** quá `keep_days`. Vượt `max_mb` thì xoá file cũ nhất của goal đã merge trước; vẫn vượt thì chỉ báo 🔔, không xoá file goal đang làm.
- [ ] Test: goal merged cũ bị dọn; goal đang làm giữ nguyên; vượt dung lượng → thông báo.

### Task 4: Xoá cả thư mục project (anh Zon yêu cầu)

**Files:** Modify `src/cli.ts` (`btm attachments purge <KEY>`), `src/server/http.ts` (`POST /api/attachments/purge` `{ key }`), `src/store/db.ts` (đặt `questions.image` / `notes.image` = NULL cho project đó), `web/index.html`; tests.

- Xoá **toàn bộ** `<data_dir>/attachments/<KEY>/`. Dashboard: nút trong Settings → Storage, hỏi xác nhận gõ lại KEY. 409 khi project đó đang có phiên chạy.
- Đưa vào danh sách dọn test project (GT, MG, GTM) cùng repo GitHub, deploy key, `/srv/btm-repos/<test>`.
- [ ] Test: purge GT xoá hết `GT/`, `MG/` còn nguyên; DB không còn trỏ tới file đã xoá; phiên đang chạy → 409.

### Task 5: Backup + màn Storage

**Files:** Modify script backup (thêm `attachments/` vào bản backup DB), `web/index.html` (Settings → Storage: dung lượng theo project, danh sách file, xoá từng file, Purge); `docs/i18n-strings.md`.

- Gắn với dòng "Settings" trong bảng phần UI dư của Plan 9.
- [ ] Test: backup có `attachments/`; web hiển thị bằng `textContent`.

## Anh cần chốt khi làm

1. `keep_days` (đề xuất 30) và `max_mb` (đề xuất 500).
2. Có viết lại lịch sử git để gỡ ảnh cũ đã commit ở `team/inbox/` không. Đề xuất: **không** với BTM; repo test (GameTest-BTM) thì xoá luôn cả repo khi dọn.
3. Tên nhóm Linux cho worker đọc kho (đề xuất `btm-workers`).
