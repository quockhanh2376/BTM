# P4-FIX-G vòng 2 · Victor · C8 đang chặn cả việc hợp lệ

Cheki kiểm FIX-G: C3–C7 ổn. C8 sai hướng: build/test/cài gói hợp lệ luôn sinh file ignored (`dist/`, `coverage/`, cache, `node_modules` khi Dev `npm install` gói mới) → hiện tại mọi lượt như vậy thành `ignored_file_planted` → `needs_owner`. BTM sẽ dừng gần như mọi ticket.

Sửa (test trước; giữ các test C3–C7):
1. File ignored MỚI ngoài `node_modules/` (so với snapshot): **xoá im lặng** ngay TRƯỚC gate và TRƯỚC lượt QC/audit (để gate/QC chạy từ trạng thái sạch). KHÔNG phải vi phạm, không `needs_owner`. Ghi note turn `ignored_cleaned:<số file>`.
2. `node_modules/` mới hoàn toàn (trước không có) → hợp lệ, không xoá.
3. `node_modules/.bin` thêm/đổi file: vi phạm `ignored_file_planted` CHỈ khi trong lượt đó `package.json` và lockfile (`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`) KHÔNG đổi (so với snapshot). Có đổi = Dev thêm gói, hợp lệ.
4. Sửa test C8 hiện có cho đúng hành vi mới; thêm test: lượt Dev tạo `dist/x.js` + `coverage/` → gate vẫn chạy, ticket không needs_owner, file đã bị xoá trước gate; lượt QC sửa `node_modules/.bin/vitest` khi không đổi package.json → vi phạm.

Scope: src/core/guard.ts, src/core/session.ts, src/server/host.ts, tests liên quan. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows. Báo cáo: ghi đè team/reports/P4-FIXG-dev.md (≤10 dòng).
