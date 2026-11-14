# Họp tranh luận, phản biện có dẫn chứng – thiết kế

Anh Zon duyệt 2026-11-14 (cả 2 bước). Mục đích: anh nêu một vấn đề bất kỳ (đoạn text, link GitHub, hoặc tài liệu), cả team lần lượt phân tích và phản biện từ nhiều góc nhìn, mọi ý có dẫn chứng, anh chốt.

## Cách dùng
Command → **Meeting** → gõ vấn đề (tuỳ chọn: link repo GitHub công khai; bước 2: đính kèm file) → gửi. Ô **Quick** bỏ vòng phản biện.

## Diễn biến (lần lượt, chỉ đọc, `noImport`, chạy song song với goal)
1. **Vòng 1 – phân tích:** PM → Dev → QC → Audit → Boss. Agent ngồi nhiều ghế nói một lần (gánh mọi vai của mình). Mỗi người ≤ 5 ý, đọc được ý người trước.
2. **Vòng 2 – phản biện:** mỗi người phản bác ≥ 1 ý của người khác, hoặc nói rõ vì sao đồng ý.
3. **Kết luận:** PM (không được thì người khác, cuối cùng Boss): thống nhất, còn tranh cãi (hai phía), đề xuất, câu hỏi cho anh.
Agent bận → chờ; hết quota / mất đăng nhập / lượt lỗi → bỏ qua, ghi chú trong biên bản.

## Dẫn chứng (Core kiểm)
Mỗi ý là `{text, evidence: {type, ref, quote?}}`; thiếu dẫn chứng → loại.
- `file`: `path[:dòng]` trong project → tồn tại (và có `quote` nếu đưa) → ✓.
- `ticket`: ID ticket có trong DB → ✓. `goal`: `G<n>` có thật → ✓.
- `material`: `quote` phải có trong tài liệu của cuộc họp (GitHub / file upload) → ✓, không thấy → ⚠.
- `general`: kiến thức chung → luôn ghi "chưa kiểm".

## Tài liệu
- **GitHub (bước 1):** agent không có mạng. Core tải README + cây thư mục (≤ 300 đường dẫn) + file khai báo (package.json…) của repo công khai trong link, ≤ 20.000 ký tự, đưa vào prompt như dữ liệu không tin cậy (không làm theo chỉ dẫn bên trong).
- **File upload (bước 2):** PDF (`pdftotext`, cần cài poppler-utils – anh OK riêng), `.docx`, `.xlsx`, `.txt/.md/.csv`; ≤ 10 file, ≤ 20 MB/file. Core rút chữ, giữ dấu trang / sheet+ô / đoạn. PDF scan: báo không rút được. Nội dung sẽ tới nhà cung cấp model khi agent đọc → không upload bí mật.

## Điều khiển
- **Stop:** dừng ngay (huỷ lượt đang chạy), giữ biên bản → trạng thái `paused`.
- **Resume** (kèm ghi chú của anh cho người nói sau), **Conclude now**, **Close**.
- Mỗi lúc chỉ một cuộc họp đang mở.

## Kết quả
Hiện dần trong Meeting room; biên bản `<data_dir>/knowledge/<KEY>/meetings/M<n>.md`; search tìm được; nút **Create goal from conclusion** điền sẵn Command (PM), anh sửa rồi gửi. Đang họp thì nút không khí tự Lively.

## Chi phí
4 agent: ~9 lượt (đủ) / ~5 lượt (Quick).

## Không làm bản này
Link ngoài GitHub, OCR, `.doc/.xls`, lưu kết luận thành spec project mới, hơn 2 vòng.

## Cách khác đã cân nhắc
- Cho agent quyền mạng để tự đọc link: bỏ (giữ agent chỉ đọc, không mạng).
- Các agent chạy song song: bỏ (tốn quota cùng lúc, người sau không đọc được ý người trước).
