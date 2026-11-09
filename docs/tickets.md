# BTM – Chuẩn Goal & Ticket

> Trạng thái: chuẩn đã chốt với anh Zon (2026-11-09) · Áp dụng từ Kế hoạch 4.
> Thay thế "thẻ task T-xxx" của v1.0. Mọi agent (PM, Dev, QC, Audit) làm và báo cáo theo đúng mã ở đây.

## 1. Khái niệm

| Khái niệm | Ai tạo | Mã | Ví dụ |
|---|---|---|---|
| **Goal** – mục tiêu anh Zon giao | Anh Zon (khung lệnh / Cả team) | `G<n>`, tăng dần theo project, không dùng lại | `G1` |
| **Ticket** – một đầu việc vừa một lượt Dev | Elon-PM, tự chia theo khối lượng | Ticket ID `<KEY>-<nnnn>` | `GTM-0012` |
| **Ticket number** – vị trí của ticket trong goal | Elon-PM | `G<n>#<k>/<tổng>` | `G1#3/9` |

- `<KEY>`: 2–5 chữ in hoa, đặt khi `btm init` (Go to the Moon → `GTM`; BTM → `BTM`).
- Ticket ID là số thứ tự **toàn project**, không reset theo goal, không dùng lại kể cả khi ticket bị hủy.
- Ticket number cố định khi PM chia xong. Thêm ticket giữa chừng thì nhận số tiếp theo và tổng tăng lên (`G1#10/10`); các ticket cũ giữ số của mình.

## 2. Vòng đời

```
Goal:   open ──► in_progress ──► qc_done ──► audit_passed ──► approved ──► merged
                                     │              │
                                     └─ (không có Kai) ┘
Ticket: pending ─► in_dev ─► awaiting_qc ─► passed
                     ▲            │
                     └─ returned ◄┘          failed / blocked / cancelled
```

1. Anh giao **G1** → Elon đọc yêu cầu, chia N ticket, mỗi ticket một file, ghi `G1#k/N`.
2. (Duyệt thẻ thủ công hoặc Auto duyệt thẻ) → Jacky làm từng ticket theo thứ tự number, Jenny QC từng ticket.
3. Mọi ticket của G1 `passed` → goal `qc_done`.
4. **Kai (Audit)** – nếu ghế `audit` có người ngồi: review toàn bộ diff của G1 (bảo mật: secret, injection, auth, quyền file, dependency mới) → báo cáo audit → goal `audit_passed`; rớt → mở ticket sửa mới trong cùng goal (`G1#10/10`, gắn `from_audit: true`).
5. Anh Zon xem tổng kết goal → **duyệt merge** (`approved`) → merge vào `main` (`merged`). Chỉ anh merge (`git.merge_by: owner`).

## 3. File ticket

`team/tickets/<TicketID>.md`, front matter YAML (chuỗi có `: ` phải đặt trong nháy):

```yaml
id: GTM-0012
goal: G1
number: 3
of: 9
title: "Form reset mật khẩu: gửi email chứa link có hạn 15 phút"
depends_on: [GTM-0010]          # tuỳ chọn, ticket phải xong trước
scope: [src/auth/reset.ts, tests/auth/reset.test.ts]
acceptance:
  - "Email hợp lệ → gửi link, link hết hạn sau 15 phút"
  - "Email không tồn tại → vẫn trả thông báo chung (không lộ tài khoản)"
done_when: "Test mới cho cả 2 tiêu chí đều pass"
note: N-4                        # tuỳ chọn, ghi chú team gốc
from_audit: false                # true nếu Kai yêu cầu
```

Luật (Core kiểm tra): `id`, `goal`, `number`, `of` bắt buộc; `number` ≤ `of`; không trùng `number` trong cùng goal; acceptance 1–5 mục; scope là đường dẫn trần.

## 4. Báo cáo – luôn kèm mã

Mỗi báo cáo bắt đầu bằng dòng mã, rồi tối đa 5 dòng Bug / Cần sửa / Cần xác nhận (ổn ghi OK):

```
GTM-0012 · G1#3/9 · Jacky-Dev
OK
```

| Ai | File |
|---|---|
| Dev | `team/reports/<TicketID>-dev.md` |
| QC | `team/reports/<TicketID>-qc.json` (thêm trường `ticket`, `goal`, `number`) |
| Audit | `team/reports/<Goal>-audit.md` (vd `G1-audit.md`) – liệt kê Ticket ID đã xem |
| PM tổng kết goal | `team/goals/<Goal>.md` – bảng toàn bộ ticket: số, ID, tiêu đề, trạng thái, vòng sửa |

## 5. Kai – Cyber Security Analyst / Audit (vai trò tương lai)

- Ghế mới `audit` trong `btm.config.yaml` (`seats.audit: kai`, `agents.kai.can_sit: [audit]`). Không cấu hình → bỏ qua bước audit.
- Chỉ đọc (như QC): không sửa code, không commit.
- Phạm vi: toàn bộ diff của goal so với `main`. Checklist tối thiểu: lộ secret/token, injection (SQL/command/path), xác thực & phân quyền, upload/đường dẫn file, dependency mới, log lộ dữ liệu nhạy cảm.
- Kết quả JSON: `{verdict: pass|fail, findings: [{ticket, severity: high|medium|low, text}]}`. `high`/`medium` → `fail` → ticket sửa mới.
- Người đã code ticket trong goal không được ngồi ghế audit cho goal đó.

## 6. Dashboard (sẽ làm ở Kế hoạch 4)

- Bảng task nhóm theo goal: tiêu đề `G1 · UI login + reset pass · 6/9 đạt`, mỗi dòng ticket hiện `#3/9 · GTM-0012`.
- Thẻ ghế và nhật ký hiện Ticket ID đang làm.
- Goal `qc_done`/`audit_passed` có nút **Duyệt merge** (chỉ anh).
