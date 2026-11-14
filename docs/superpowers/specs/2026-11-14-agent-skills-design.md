# Skill cho agent (Settings) – thiết kế

Anh Zon duyệt 2026-11-14, kèm yêu cầu: kiểm bảo mật 2 vòng (Boss rồi Finn kiểm chéo) trước khi skill vào thư viện.

## Mục đích
Thêm hướng dẫn cách làm (skill) cho đúng ghế, đúng project; BTM lọc + đề xuất, anh chốt. Skill là nội dung bên thứ ba → phải qua cổng bảo mật.

## Thư viện (dùng chung mọi project)
- Thêm bằng: dán nội dung `SKILL.md`, hoặc link repo GitHub công khai (Core tải các `SKILL.md`, liệt kê, anh tick).
- Chỉ lưu CHỮ + nguồn + phiên bản (ngày tải); không tải / không chạy script, hook, file đính kèm. ≤ 8.000 ký tự / skill.

## Cổng bảo mật (skill ở khu chờ, chưa ai dùng được)
0. **Core quét** (không AI): tải-rồi-chạy (`curl|sh`…), chuỗi mã hoá dài, "bỏ qua chỉ dẫn trước", gửi dữ liệu / token ra ngoài, xoá phá (`rm -rf`), ký tự ẩn, nhắc script. Mức `high` → từ chối luôn.
1. **Boss (MB)** kiểm – lượt chỉ đọc, skill là dữ liệu không tin cậy trong prompt.
2. **Finn (Claude)** kiểm chéo độc lập (không thấy kết quả của Boss).
Người kiểm 1: agent `provider: zai` (đang bật); không có → agent khác. Người kiểm 2: agent Claude không phải Boss (ưu tiên ghế PM). Hai người PHẢI khác nhau; thiếu người / hết quota → chờ.
Cả hai `safe` → `approved`. Một bên `unsafe` → `rejected` + lý do. Không có nút bỏ qua cổng.

## Lọc + gán
- **Ghế:** BTM đề xuất theo mô tả (code → Dev; review/test → QC; bảo mật → Audit; kế hoạch/spec → PM); anh tick PM / Dev / QC / Audit.
- **Project:** "mọi project" hoặc chỉ các project anh chọn; BTM gợi ý theo bản đồ project (ngôn ngữ, có giao diện, có test).
- Skill `approved` vào thư viện ở trạng thái TẮT; anh bật.

## Áp dụng
Lượt của ghế nào → chỉ skill đang bật của ghế + project đó, ≤ 6.000 ký tự / lượt. Ưu tiên: quy định BTM → chuẩn Settings → skill. Skill không cấp thêm quyền / lệnh.

## Không làm bản này
Tự kiểm bản mới, skill cho hỏi đáp / họp, ghi skill đã dùng vào dòng thời gian ticket.
