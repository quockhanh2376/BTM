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

- Mọi chữ hiển thị qua `tx()` + bảng `STRINGS`, thêm dòng vào `docs/i18n-strings.md`. Tiếng Việt chỉ nằm trong `STRINGS` hoặc kho thoại `CHAT_LINES`.
- Màu qua token CSS; làm cả light và dark; nút đỏ chỉ cho việc nguy hiểm.
- Xác nhận dùng `askOwner` / `askAsSeat` (giọng agent), không `confirm()` của trình duyệt.
- Giờ hiển thị cho anh Zon là giờ VN (`Asia/Ho_Chi_Minh`).
- Kiểm trên preview trước khi báo xong (light + dark, khổ hẹp).

## 5. Nợ kỹ thuật cần trả (theo thứ tự)

| Nợ | Vì sao | Hướng |
|---|---|---|
| `web/index.html` ~7.400 dòng, một file | khó đọc, dễ đụng nhau, test phải cắt chuỗi | tách JS/CSS ra file tĩnh cùng origin (CSP `'self'` cho phép), theo khu: chat, goals, accounts, questions… |
| `src/core/session.ts` ~2.450 dòng | luồng PM/Dev/QC/Audit chung một file | tách từng lượt (pm/dev/qc/audit) + guard dùng chung |
| `src/server/http.ts` ~1.000 dòng route | thêm route là thêm vào một hàm dài | tách router theo nhóm (goals, tickets, questions, accounts) như `accounts-api.ts` |
| `src/store/db.ts` ~1.600 dòng | mọi bảng chung một object | tách theo bảng, giữ một `Store` interface |
| Lệnh trực tiếp Dev/QC/PM/Audit có nhiều nhánh gần giống nhau trong `host.ts` | dễ sót trường hợp (lỗi lệnh Audit kẹt 2026-11-14) | một hàm chạy lượt dùng chung, tham số ghế/chỉ đọc |
| Bản Việt của giao diện (nút VI) | chưa làm | thêm `STRINGS.vi` |

Trả nợ theo từng PR nhỏ, **không đổi hành vi**, test xanh trước và sau.
