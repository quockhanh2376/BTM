Bug: web/index.html:520 — số đếm tab active theme sáng chỉ đạt tương phản ≈3,57:1, dưới 4,5:1.
Bug: web/index.html:539 — bảng có nhiều cột nowrap, thiếu xử lý tràn; trên mobile có thể đẩy trang cuộn ngang.
Bug: web/index.html:1434 — fingerprint phụ thuộc thứ tự task; đổi thứ tự dù trạng thái giữ nguyên vẫn xóa lựa chọn tay.
Cần sửa: tests/web.test.ts — kiểm tra tương phản bỏ sót nền số đếm pha alpha; thiếu kiểm thử layout mobile thực tế.