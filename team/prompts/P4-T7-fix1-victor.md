# P4-T7 · fix 1 · Victor

Audit fail vì lỗi HỆ THỐNG (không phải lỗi code) đang bị gửi cho PM viết ticket sửa → PM viết ticket vô nghĩa, tốn lượt.

Sửa trong `runSession` (đoạn sau `parseAuditResult`, session.ts ~dòng 1057–1102):
- Findings chỉ gồm `audit_output_invalid` và/hoặc `audit_modified_repo` → vẫn ghi `G<n>-audit.md` + commit như hiện tại, rồi dừng `needs_owner` với note đúng tên đó. KHÔNG gọi lượt PM.
- Verdict `fail` mà `findings` rỗng → `needs_owner`, note `audit_fail_no_findings`. KHÔNG gọi lượt PM.
- Còn lại (có finding thật) → giữ nguyên luồng PM như hiện tại.

Test (tests/session.test.ts): 3 case trên → status `needs_owner`, đúng note, runner KHÔNG được gọi cho ghế pm sau lượt audit; có `team/reports/G1-audit.md`.

Scope: src/core/session.ts, tests/session.test.ts. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).
Báo cáo: ghi đè team/reports/P4-T7-dev.md.
