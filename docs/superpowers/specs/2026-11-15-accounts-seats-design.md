# Accounts theo thẻ ghế: đa acc, đa công cụ (anh Zon 2026-11-15)

## Vì sao
Anh muốn nhìn và quản lý acc theo vị trí, không theo người:
thẻ 1 luôn làm PM, thẻ 2 Dev, thẻ 3 QC, thẻ 4 Audit, thẻ 5 là MB (Boss) dự phòng cho mọi ghế.
Mỗi thẻ chứa nhiều acc, thuộc nhiều loại (Claude, Codex, Antigravity). Hai ghế không bao giờ dùng chung một acc hay một quota.
Chỉ MB dùng API key. Các acc khác vào BTM bằng Login hoặc import/export file JSON.

## Ba hướng đã cân nhắc
- **Thẻ ghế dựng trên Worker sẵn có (chọn).** Mỗi Worker hiện nay (Finn, John, Marry, Bruno) trở thành một thẻ và chỉ ngồi đúng một ghế. Boss giữ nguyên. Acc thuộc thẻ, mỗi acc có công cụ riêng (đã có từ PR #147). Vì mỗi thẻ một ghế và mỗi acc ở một thẻ, hai ghế không thể dùng chung quota. Phần chạy lượt, đo quota, họp, hỏi đáp không phải viết lại.
- Viết lại thành "kho acc chung + gán acc vào ghế". Cùng kết quả cho anh nhưng phải sửa gần hết phần lõi, rủi ro cao, không thêm được gì.
- Giữ "một người ngồi nhiều ghế" và thêm luật chia acc giữa các ghế. Khó hiểu hơn cách thẻ, không còn cần.

## Cách hoạt động
- 5 thẻ theo thứ tự cố định: **1 PM · 2 Dev · 3 QC · 4 Audit · 5 Boss (MB)**. Tên và avatar (Finn, John…) vẫn là tên của thẻ, đổi được như bây giờ.
- **Tên trên giao diện đổi được, tên trên VM cố định (anh Zon).** Mã thẻ (`elon`, `jacky`, `jenny`, `bruno`, `mb`) và user Linux của từng acc (`btm-<thẻ>-<acc>`) không bao giờ đổi tên. Đổi tên thẻ hay nhãn acc trên dashboard chỉ đổi chữ hiển thị.
- Trong một thẻ, acc xếp theo thứ tự ↑↓. Ghế dùng acc đầu tiên còn dùng được. Hết quota hoặc mất đăng nhập thì tự chuyển sang acc kế tiếp trong thẻ (đã có).
- Cả thẻ không còn acc nào dùng được thì Boss ngồi thay ghế đó (đã có). Boss cũng hết thì ghế chờ.
- Luật "người code không tự QC" vẫn đúng tự nhiên vì Dev và QC là hai thẻ khác nhau.

## Việc phải làm
1. **Giao diện Accounts theo thẻ ghế.** Sắp 5 thẻ đúng thứ tự trên, tiêu đề ghi số thẻ và ghế. Mỗi thẻ có nút "+ Thêm acc" mở sẵn form cho thẻ đó, chọn được công cụ. Nút Login trên acc có sẵn đổi thành "Đăng nhập lại acc này".
2. **Chuyển acc sang thẻ khác.** Mỗi acc có nút "Chuyển sang thẻ…". BTM chép token sang user Linux mới của thẻ đích rồi xoá acc ở thẻ cũ. Không chuyển được acc đang chạy lượt và acc `default` của thẻ. Số đo quota cũ của acc đó được đọc lại từ đầu.
3. **Email trùng thì bỏ qua.** Import vẫn chạy; mục nào có email đã nằm ở bất kỳ acc nào trên BTM thì bỏ qua, tóm tắt ghi "đã có ở thẻ/acc". Nạp lại token cho đúng acc cũ (cùng email, cùng thẻ) vẫn dùng ô tick "ghi đè", mặc định không tick. Add tay hoặc Login ra email đã có ở acc khác thì báo lỗi, nói rõ đang ở đâu. Email acc Claude lấy từ `claude auth status`, acc Codex lấy từ `id_token` trong `auth.json`; không đọc được thì để trống, không chặn.
4. **Antigravity ngồi được QC/Audit.** Đã thử trên VM: `agy --mode plan` không ghi được file vào thư mục làm việc. Ở QC/Audit, Antigravity chạy `--mode plan`, không được chạy lệnh nào; bước kiểm tra sau lượt (`guardStoredAgentTurn`) vẫn giữ. Anh chốt 2026-11-15, mục tiêu là tăng chất lượng code: bài do Antigravity code thì không để Antigravity kiểm. Khi ghế Dev đang chạy acc Antigravity thì QC/Audit bỏ qua acc Antigravity, dùng acc loại khác trong thẻ hoặc Boss; Dev chạy loại khác thì QC/Audit dùng Antigravity bình thường. Bỏ luật cấm trong config.ts và `canRunOnSeat`.
5. **Model theo công cụ trong mỗi thẻ.** Hiện model/effort của thẻ chỉ áp cho acc cùng công cụ chính. Đổi thành: mỗi thẻ chọn model riêng cho từng công cụ đang có acc trong thẻ.
6. **Cấu hình VM.** Sửa `btm.config.yaml`: Finn chỉ PM, John chỉ Dev, Marry chỉ QC, Bruno chỉ Audit, Boss mọi ghế. Xoá lựa chọn ghế cũ trên dashboard (hiện Dev = Marry, QC = Finn). Ô đổi người trên thẻ ghế chỉ còn hai lựa chọn: thẻ đó hoặc Boss.

7. **Dev, QC, Audit của một ticket luôn là ba thẻ khác nhau.** Luật `coder_cannot_qc_same_task` giữ nguyên (thẻ đã code ticket thì không QC ticket đó, kể cả khi Boss ngồi thay). Thêm luật tương tự cho Audit: thẻ đã code hoặc đã QC ticket đó thì không Audit nó. Không còn thẻ nào hợp lệ thì ghế chờ, không tự kiểm bài của mình.

## Không làm
- Không đổi Boss: vẫn API key, vẫn là dự phòng cuối.
- Không cấm bằng code việc một Worker ngồi 2 ghế (project cũ và test còn dùng); chỉ cấu hình VM theo kiểu một thẻ một ghế.
- Không tạo thêm thẻ thứ 6. Thêm ghế mới là việc khác.

## Để người làm tự quyết
- Câu chữ EN/VI, chỗ đặt nút.
- Cách lưu model theo công cụ (khoá setting).
