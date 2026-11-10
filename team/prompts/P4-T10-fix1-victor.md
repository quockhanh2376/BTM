# P4-T10 · fix 1 · Victor (sửa yêu cầu – lỗi nằm ở plan của Cheki, không phải code của bạn)

Vấn đề: sau migrate, code trả về nhánh cũ (vd `session/12`) – nhánh này KHÔNG có `team/project.yaml`. `btm run` (`readProjectKey` ở session.ts) và dashboard (`snapshot.ts` ~dòng 227) đọc KEY từ working tree hiện tại → `btm run` bị từ chối, dashboard trống goal ngay sau khi migrate.

**Sửa:**
1. `migrateProject`: thành công (cả trường hợp `already` tìm thấy trên protected branch) → **ở lại `protectedBranch`**, không checkout về nhánh cũ. Lỗi → vẫn trả về nhánh cũ như hiện tại. Trả thêm `previousBranch` trong kết quả để CLI in ra: "Đã chuyển sang <protected>; nhánh cũ <x> giữ nguyên".
2. `snapshot.ts`: `readProjectKey` lỗi → vẫn dựng `goals` từ store (title/type/size/number/of trong bảng tickets), chỉ bỏ phần đọc file ticket. Không còn trả `goals: []` chỉ vì thiếu project.yaml khi store có goal.
3. Sửa test: case project cũ → sau migrate nhánh hiện tại là `main`, `session/3` không đổi (so sha), team/tasks còn nguyên; thêm test snapshot: store có goal + working tree không có project.yaml → goals vẫn hiện.

Scope: src/project/migrate.ts, src/cli.ts, src/server/snapshot.ts, tests/migrate.test.ts, tests/snapshot.test.ts. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (15 Windows).
Báo cáo: ghi đè team/reports/P4-T10-dev.md (ngắn, ≤ 10 dòng).
