# Review độc lập lần 2 – toàn nhánh plan4-tickets (2026-11-09)

Reviewer mới. Kết luận: **needs fixes**. tsc sạch; Windows 642/657 (15 fail chỉ Windows).

## A. 10 lỗi review 1
Đã sửa cả 10 (#2 sửa cho luồng phiên, bị mở lại qua lệnh trực tiếp – xem B4).

## B. Lỗi mới
| # | Mức | Chỗ | Lỗi | Sửa ở |
|---|---|---|---|---|
| B1 | High | guard.ts:22,49 | `rev-parse main` ưu tiên TAG tên `main` → agent commit lên main rồi tạo tag main=sha cũ → guard không thấy (reviewer đã tái hiện) | FIX-D |
| B2 | High | guard.ts; goal.ts:128-138 | Nhánh goal khác / tag trùng tên không được bảo vệ; approve merge theo tên, không ghim sha đã QC/audit → code chưa QC vào main khi anh bấm Duyệt merge | FIX-D |
| B3 | High | git.ts | Agent ghi `.git/hooks/*` hoặc `.git/config` (hooksPath, fsmonitor) → git của BTM chạy hook sau guard, hook sửa main | FIX-D |
| B4 | Med | host.ts:307 + gate | Commit lệnh trực tiếp `G<n>: cmd …` nằm trong dải commit ticket đang làm → ticket fail mãi | FIX-E |
| B5 | Med | session.ts:879-886 | Dev trả BLOCKED → commit hết không qua gate (sửa ticket lọt) | FIX-E |
| B6 | Med | guard (snapshot chỉ trong RAM) | Process chết giữa lượt → không guard, lượt sau lấy main đã bị sửa làm gốc (chưa xác minh runtime) | FIX-E |
| B7 | Low | guard.ts:47-59, 68 | Agent xoá main → catch nuốt lỗi, không báo; xoá nhánh goal → throw | FIX-D |
| B8 | Low | session.ts:537-565 | PM ghi ticket cho goal khác / ID ngoài dải → commit mà không đăng ký, sau này kẹt | FIX-E |
| B9 | Low | session.ts:362 | Chạy lại goal đã merged/approved → state về in_progress, lại hiện Duyệt merge | FIX-E |

Không thấy lỗi giao diện mới (textContent, encodeURIComponent); POST approve qua guard x-btm/Origin/JSON.
