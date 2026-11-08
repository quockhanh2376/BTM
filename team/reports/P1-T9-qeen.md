Bug: [src/cli.ts:133](/srv/agent-projects/btm/src/cli.ts:133) vẫn để init dở dang nếu mở DB hoặc `setActiveProject` lỗi: project đã tạo còn lại, chạy lại cùng tên bị từ chối.
Cần sửa: xử lý rollback project khi đăng ký active thất bại; thêm test cho nhánh này.
Cần xác nhận: bốn lỗi còn lại đã sửa theo code; `tsc --noEmit` PASS. Chưa chạy test vì sandbox chỉ đọc, test cần tạo file/DB.