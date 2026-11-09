# P4-FIX-B · Qeen · Review luật ticket

Đọc: team/reviews/P4-review-1.md (#5 #6 #7 #9 #10), team/prompts/P4-FIXB-victor.md, team/reports/P4-FIXB-dev.md.

**Kiểm:**
1. PM thất bại ở MỌI nhánh → team/tickets/ về đúng trước lượt PM, không commit ticket hỏng, không upsert, không tăng counter.
2. ID ticket mới phải liên tiếp nextSeq..nextSeq+N-1; KEY-9999 không làm hỏng project.
3. Coder ≠ QC / audit tra theo ticketHistory mọi phiên.
4. Dev sửa team/tickets → `ticket_tampered`, file ticket được khôi phục từ base + commit; ticket đọc lại đúng scope cũ.
5. Dọn tree sau lệnh gate KHÔNG xoá thay đổi của Dev (Dev đã được commit trước gate) và chỉ chạy trên nhánh goal.
6. Không có test bị xoá; `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.

Ghi chú Cheki: Ubuntu 653/653 ×3.
**Báo cáo:** team/reports/P4-FIXB-qeen.md
