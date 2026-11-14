# BTM – Quy tắc kỹ thuật (chất lượng, bảo trì, phát triển tiếp)

> Anh Zon yêu cầu 2026-11-14: **BTM ưu tiên chất lượng code, dễ bảo trì, dễ phát triển thêm.** Mọi thay đổi (Cheki, Victor, Qeen, agent) theo các quy tắc dưới đây. Khi một quy tắc cản việc đúng, sửa quy tắc trong file này (PR riêng), không lách.

## 1. Thay đổi nhỏ, đủ, có test

- Mỗi PR một việc. Thay đổi đủ phạm vi (caller, test, tài liệu, chuỗi i18n) nhưng không thêm tính năng "để sau".
- Logic mới (nhánh, vòng lặp, parser, bảo mật, tiền, dữ liệu) **phải có test**; sửa lỗi phải có test tái hiện đúng lỗi đó (ghi ngày + bối cảnh trong comment test).
- Trước khi merge: **test trên VM ×3 xanh** (`/tmp/btm-vmt6.sh`). Lỗi test chỉ do Windows (tmpdir, symlink, tên file) ghi rõ là lỗi môi trường, không bỏ qua lỗi khác.
- Deploy chỉ khi anh Zon đồng ý và không có phiên chạy.

## 2. Cấu trúc code

- **File mới cho trách nhiệm mới** (vd `src/server/goal-trash.ts`, `ask-lane.ts`, `knowledge/digest.ts`), không nhồi thêm vào file lớn.
- Hàm thuần (không I/O) tách khỏi phần có I/O để test được; giao diện cũng vậy (hàm thuần trong `web/index.html` được test bằng cách cắt chuỗi).
- Dùng lại helper có sẵn trước khi viết mới (`git`, `gitAsync`, `askOwner`, `askAsSeat`, `formatHHmm`, `agentLabel`, `tx`…).
- Không thêm dependency khi vài dòng code làm được; thêm thì phải có lý do ghi trong PR.
- Comment chỉ ghi **vì sao** (tiếng Việt, kèm ngày/bối cảnh nếu là bài học), không ghi lại code làm gì.

## 3. An toàn (không bao giờ nới)

- Không API key trong môi trường BTM; không in/đọc/commit token, ngoài đường export/import ở decision 0005.
- Không `--dangerously-skip-permissions`, `bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`; không mở quyền `node -e` cho agent.
- Output của agent luôn là dữ liệu không tin cậy: giao diện dùng `textContent`, không `innerHTML`; backend parse bằng zod, cắt độ dài, bỏ ký tự điều khiển.
- Lượt chỉ đọc chạy song song **không bao giờ nhập workspace về checkout** (`noImport`).
- Không force-push; release không đẩy `team/`; không đụng main/GitHub khi xoá goal.
- Ghi DB trên VM bằng tay chỉ khi anh Zon đồng ý và đã sao lưu; ưu tiên làm thành tính năng để không phải sửa tay lần sau (như nút Retry, Thùng rác).

## 4. Giao diện

- Mọi chữ hiển thị qua `tx()` + bảng `STRINGS`, thêm key ở cả `en` và `vi` (test bắt thiếu key), thêm dòng vào `docs/i18n-strings.md`. Tiếng Việt chỉ nằm trong `STRINGS` hoặc kho thoại `CHAT_LINES`.
- Màu qua token CSS; làm cả light và dark; nút đỏ chỉ cho việc nguy hiểm.
- Xác nhận dùng `askOwner` / `askAsSeat` (giọng agent), không `confirm()` của trình duyệt.
- Giờ hiển thị cho anh Zon là giờ VN (`Asia/Ho_Chi_Minh`).
- Kiểm trên preview trước khi báo xong (light + dark, khổ hẹp).

## 5. Nợ kỹ thuật cần trả (theo thứ tự)

| Nợ | Trạng thái 2026-11-14 | Còn lại |
|---|---|---|
| `web/index.html` 7.400 dòng | ✅ tách: `index.html` 611 + `web/app/{app.css, i18n.js, chat-lib.js, app.js}` (#97, #98) | ✅ 2026-11-14: `app.js` 2.706 → 1.840 sau khi tách thêm `questions.js` (254), `diff.js` (148), `seats.js` (297), `inbox.js` (247, gồm ảnh kèm note) theo mẫu `btmX(d)` nhận helper qua `d`. Còn trong `app.js`: avatar ghế (`renderSeatAvatar`, `shrinkAvatar` – test cắt chuỗi `askOwner` → `renderSeatAvatar`), ô Command (gửi, Auto, mic), System/Trash/Lessons, Search, Boss key |
| Lệnh trực tiếp nhiều nhánh trong `host.ts` | ✅ `src/server/direct-command.ts`, một bước chạy chung (#100); `host.ts` 1.218 → 884 | – |
| `src/server/http.ts` route dài | ✅ `src/server/routes/{goals,tickets,questions}.ts` (#101); 1.082 → ~800. 2026-11-14 tách nốt: `routes/{notes,seats,session,meeting,skills,settings}.ts` (220, 117, 120, 91, 79, 94 dòng); `http.ts` 929 → 423, `routes/goals.ts` 265 → 140 (chỉ còn việc của goal) | – |
| `src/core/session.ts` 2.450 dòng | ✅ `session-helpers.ts` (#102) + `processGoal` chia theo lượt: `src/core/goal/{ctx,pm-planning,tickets,audit}.ts` dùng `GoalCtx` (#106); `session.ts` còn ~710 | ✅ `goal/tickets.ts` 775 → 91: `ticket-run.ts` (trạng thái ticket + 2 khối lặp gộp lại), `dev-turn.ts`, `qc-turn.ts` (#118) |
| `src/store/db.ts` 1.700 dòng | ✅ `types.ts`, `seats.ts`, `schema.ts` (#103); còn 1.126 | tách phần thân `openStore` theo bảng nếu còn lớn lên |
| Bản Việt của giao diện (nút VI) | ✅ 2026-11-14: `STRINGS.vi` đủ key như `STRINGS.en`; nút EN/VI lưu `btm.lang` rồi tải lại trang | – |

Trả nợ theo từng PR nhỏ, **không đổi hành vi**, test xanh trước và sau.
