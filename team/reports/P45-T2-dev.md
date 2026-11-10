Cần sửa: call site `src/core/session.ts` chưa truyền `cfg` vào gate; gate chưa áp dụng worker khi chạy production.
Cần xác nhận: cho phép thêm `src/core/session.ts` vào scope để truyền config.
Đã đổi: `src/config.ts`, `src/isolation/worker.ts`, `src/runner/run.ts`, `src/gate/gate.ts`.
Đã thêm: `tests/worker.test.ts` cho wrap/killall/schema; test chưa chạy được vì Vitest dừng với `spawn EPERM`.
TypeScript: `npx tsc --noEmit` thành công.
