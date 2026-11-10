# Review độc lập toàn nhánh plan4-tickets (2026-11-09)

Reviewer mới, không có ngữ cảnh hội thoại. Kết luận: **needs fixes**. tsc sạch; Windows 622/637 (15 fail chỉ Windows).

| # | Mức | Chỗ | Lỗi | Sửa ở |
|---|---|---|---|---|
| 1 | High | session.ts 882-900, 1054-1073, 743 | Không kiểm nhánh sau lượt agent → `reset --hard` có thể ghi đè `main`; QC tạo nhánh mới thì lọt; Dev checkout main thì commit vào main | FIX-A |
| 2 | High | session.ts 297-300, 699-701 + gate | Dừng giữa lượt Dev → lần sau commit checkpoint `G<n>:` nằm trong dải commit ticket → `commit_missing_ticket_id` mãi → ticket failed | FIX-A |
| 3 | High/Med | session.ts 865-871, 1037-1051 | QC/audit timeout/lỗi bỏ qua kiểm "không được sửa repo" → sửa đổi của QC thành WIP commit | FIX-A |
| 4 | Med-High | session.ts 434-485, 1152-1189 | PM tự `git commit` thì lọt kiểm ngoài scope / sửa ticket cũ | FIX-A |
| 5 | Med | session.ts 453-505, 1178-1189 | PM lỗi → file ticket bị commit/để lại nhưng không đăng ký → resume crash "Ticket not found"; counter không tăng | FIX-B |
| 6 | Med | session.ts 603-608, 975-981 | Luật coder≠QC/audit chỉ xét lượt của phiên hiện tại | FIX-B |
| 7 | Med | ticket.ts loadTickets | Dev sửa file ticket để nới scope/acceptance; commit bị gate từ chối vẫn ở lại | FIX-B |
| 8 | Low | session.ts 297-300 | Tree bẩn đầu phiên bị commit lên nhánh đang checkout (thường là main) | FIX-A |
| 9 | Low | session.ts 427-428, 507-515 | PM ghi `KEY-9999` → counter 10000 → không tạo được ticket nữa | FIX-B |
| 10 | Low, chưa xác minh | gate.ts | Lệnh build/lint/test để lại file → QC luôn `qc_modified_repo` | FIX-B |

Cheki đã tự xác minh #1 (dòng 894 reset trên nhánh hiện tại) và #2/#8 (dòng 297-300).
