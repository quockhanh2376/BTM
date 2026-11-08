Bug: [src/qc/result.ts:36](/srv/agent-projects/btm/src/qc/result.ts:36) bỏ qua JSON cuối bị cắt dở: `{"verdict":"pass"} {"verdict":"fail"` trả `pass`, phải trả `fail/qc_output_invalid`.
Cần sửa: Không lấy lại khối trước khi khối cuối chưa đóng; bổ sung test hồi quy.
Cần xác nhận: 4 lỗi cũ đã qua kiểm tra; 27/27 test pass, chưa thấy over-engineering.