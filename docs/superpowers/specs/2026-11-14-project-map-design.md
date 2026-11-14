# Bản đồ kiến thức project – thiết kế ngắn

Anh Zon duyệt 2026-11-14. Mục đích: team biết code đã có gì, ở đâu, ai từng sửa → không viết trùng, không "sửa chỗ này hỏng chỗ khác".

## Vấn đề hiện tại
- Dev được dặn không dò repo → không biết hàm có sẵn.
- PM ghi `scope` ticket mà không có danh sách module.
- Không ai biết file sắp sửa từng được ticket nào sửa.

## Cách làm (đã chọn: Core tự dựng, không AI)
Dựng lại mỗi lần cần từ checkout của project (luôn đúng với code), không commit vào repo.
- **Module:** `git ls-files` trừ `team/`, `node_modules/`, file nhị phân; mỗi file: dòng chú thích đầu + tên hàm/class export (JS/TS/Python, regex).
- **Spec:** dòng đầu README (bỏ tiêu đề) + mỗi goal một dòng (tiêu đề, trạng thái, số ticket).
- **Lịch sử sửa:** từ `scope` các ticket (team/tickets/*.md): `file ← GT-0002, GT-0005 (G1)`; scope là thư mục thì khớp mọi file trong đó.
- Bản mới nhất lưu `<data_dir>/knowledge/<KEY>/map.md` (ngoài git) khi duyệt goal và khi mở xem.

## Ai nhận gì
- **PM lập ticket:** cả bản đồ (≤ 4.000 ký tự) + "dùng lại module có sẵn, ghi scope đúng file".
- **Dev:** phần của scope ticket (file, hàm có sẵn, ticket cũ đã sửa; ≤ 1.500 ký tự) + "trước khi viết hàm mới xem có sẵn chưa; file từng được ticket khác sửa thì chạy lại test của chúng".
- **QC:** ticket cũ cùng file → kiểm lại acceptance của chúng (hồi quy).

## Dashboard
Nút **Map** cạnh Summary (mở dạng chữ, `GET /api/goals/:n/map` – bản đồ project lúc này). Ô search tìm trong bản đồ.

## Không làm lần này
AI viết mô tả module, sơ đồ hình, gộp nhiều project (bước workspace).

## Cách khác đã cân nhắc
- PM/Boss viết mô tả module sau mỗi goal: tốn lượt, dễ sai/cũ → để sau nếu cần.
