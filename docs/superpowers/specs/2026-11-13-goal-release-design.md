# Đề xuất: một goal chạy trọn vòng, từ lúc giao goal đến bản release a tải về test

- Ngày: 2026-11-13 · Người đề xuất: Cheki · Người quyết: anh Zon · Trạng thái: **anh đã duyệt 2026-11-13**

## Vì sao
Anh muốn G1 chạy hết một vòng thật: giao goal → làm → kiểm tra bảo mật → đẩy code lên GitHub và cập nhật tài liệu → có bản release. Sau bước cuối, anh tải app về máy và tự test.

## Hiện trạng (đã kiểm trên VM ngày 2026-11-13)
| Bước | Hiện có? | Ghi chú |
|---|---|---|
| 1. Giao goal (Command → PM) | Có | |
| 2. PM chia ticket, hỏi anh khi chưa rõ | Có | Câu trả lời của anh được gửi cho cả Dev và QC (PR #39) |
| 3. Dev làm từng ticket | Có | |
| 4. QC kiểm từng ticket | Có | |
| 5. Audit bảo mật | **Có code nhưng G1 đã bỏ qua** | Config không có ghế `audit`, nên core không báo gì mà đi thẳng sang `qc_done`. Trong repo không có `G1-audit.md` |
| 6. Cập nhật tài liệu (README, CHANGELOG) | Chưa có | mini-game hiện không có README |
| 7. Anh Approve → merge vào `main` | Có | G1 đã merge vào `main` trên VM (commit `dee6c40`) |
| 8. Đẩy lên GitHub | **Chưa có** | `origin` của mini-game chỉ là một thư mục trên VM. BTM không có lệnh push nào |
| 9. Release (tag + file tải về) | Chưa có | |
| 10. Anh tải về và test | | |

## Đề xuất: vòng đầy đủ
```
Goal → Plan (PM) → Build (Dev) ⇄ Verify (QC) → Audit bảo mật → Docs (PM)
     → [anh Approve] → merge main → push GitHub + tag vX.Y.Z → Release → anh tải về, test
```

### A. Audit bắt buộc
- **Worker mới "Bruno"** (codex-cli), chỉ ngồi ghế `audit` (`can_sit: [audit]`). Ghế `audit: bruno` có thẻ riêng trên dashboard: thẻ thứ 4 "Bruno-Audit" đã có sẵn trong giao diện, chỉ hiện khi config có ghế audit.
  - Bruno có user Linux riêng (`btm-bruno`) và tài khoản codex riêng. Anh đăng nhập codex cho Bruno qua nút "+ Add Account" như các Worker khác.
  - Bruno không bao giờ code, nên luôn đạt luật "audit khác người đã code" (luật này đã có sẵn).
- Thiếu ghế audit thì **dừng ở `needs_owner`**, ghi lý do `audit_seat_missing`, chứ không bỏ qua như bây giờ.
- Audit fail thì core tự tạo ticket sửa (đã có sẵn), Dev sửa, QC kiểm, rồi audit lại.

### B. Bước Docs (mới, sau khi audit pass)
- PM (Elon) có một lượt riêng để viết hoặc cập nhật `README.md` (cài đặt, chạy, test) và thêm một mục vào `CHANGELOG.md`. Nếu là bản đầu tiên thì đặt `version` trong `package.json` là `1.0.0`.
- Có cổng phạm vi: lượt này chỉ được sửa `README.md`, `CHANGELOG.md`, `docs/**` và trường `version` trong `package.json`. Sửa ngoài phạm vi thì bị trả về.
- Sau đó core chạy lại test của project (`npm test`) trên nhánh goal. Test đỏ thì không cho Approve.

### C. Approve → merge (giữ như cũ)
- Anh vẫn bấm Approve trên dashboard. Không push nếu anh chưa duyệt.

### D. Push lên GitHub (mới, do core làm, agent không làm)
- Mỗi project có một repo GitHub riêng. Lần test này: **`quockhanh2376/GameTest-BTM`, public** (anh chốt; anh tự xoá sau). Repo chỉ chứa code của goal, không có key hay thông tin tài khoản nào.
- Dùng **deploy key**: một khoá SSH chỉ có quyền ghi vào đúng repo đó, không phải API key.
  - Khoá nằm ở `/var/lib/btm/keys/<project>` (user `agent`, quyền 0600). Agent không đọc được, giống file ntfy.
  - Ghim `known_hosts` của github.com.
- Chỉ push sau khi merge thành công, chỉ push `main` và tag. Không bao giờ force-push.
- Push lỗi thì code vẫn nằm an toàn ở `main` trên VM. Dashboard báo `push_failed` và gửi ntfy, anh bấm "Push lại".
- Cần ghi thành **decision 0006**, vì đây là credential mới (deploy key).

### E. Release
- Core tạo tag `v<version>` từ `package.json` (ví dụ `v1.0.0`) rồi push tag lên.
- GitHub tự sinh file **Source code (zip)** trên trang Tags, anh tải về từ đó. Cách này không cần token API.
- Dashboard: khi goal ở giai đoạn Release, hiện tag và link GitHub. ntfy báo "G1 released v1.0.0".

### F. Anh tải về và test
```
Tải zip tag v1.0.0 từ GitHub → giải nén → npm test → npm start → chơi thử
```
Lỗi hoặc góp ý thì anh giao thành goal mới (G2) ở ô Command.

## Chạy trọn vòng trên project mới (anh chốt)
- Giữ nguyên project `mini-game` (G1 cũ) để tham khảo.
- Project mới **GameTest-BTM** (key `GT`), goal G1 mới, ví dụ:
  > Game bắn máy bay mini chạy trên trình duyệt: 1 người chơi (phím mũi tên + Space) đấu 1 bot tự động. Một file `server.js` (Node, không thư viện ngoài) phục vụ trang HTML/JS và chạy `npm start` → mở http://localhost:3000. Có điểm, máu, màn thắng/thua. Logic game tách module có test bằng `node --test`.
- Chạy hết các bước A → F. Sau bước F anh tải zip tag `v1.0.0` về máy: `npm test`, `npm start`, mở trình duyệt chơi thử.

## Việc phải làm (sau khi anh duyệt)
1. Thêm Worker Bruno (codex, user `btm-bruno`), ghế `audit: bruno`. Audit bắt buộc (A).
2. Bước Docs, cổng phạm vi và chạy lại `npm test` (B).
3. Push, tag, nút Push lại, ntfy (D, E). Viết decision 0006.
4. Dashboard: giai đoạn Release hiện tag và link.
5. Test, PR, VM xanh, rồi deploy (cần anh OK).

## Anh đã chốt (2026-11-13)
1. Audit: **Bruno (codex)**, thẻ riêng.
2. Repo: **GameTest-BTM, public**, Cheki tạo; anh tự xoá sau. Không key, không thông tin tài khoản trên repo.
3. Release: **tag + zip của GitHub** là đủ.
4. Goal mới trên project mới: game bắn máy bay trên trình duyệt (người chơi đấu bot), `server.js`.
