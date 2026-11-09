# P4-T10 fix 2: Sửa config và git identity trong tests/migrate.test.ts

- `tests/migrate.test.ts`: đọc file mẫu `btm.config.yaml` đầy đủ các trường schema (rules, energy, login, gate, plugins, runner) và ghi đè `host.*` để tránh lỗi validation.
- Dùng helper `tmpRepo` thiết lập sẵn git user (name & email) tránh lỗi auto-detect identity trên Windows.
- Toàn bộ 6 test trong `tests/migrate.test.ts` đều pass (0 fail).
- `npx tsc --noEmit` sạch không lỗi (exit 0).
- `npx vitest run`: 622 passed, 15 failed (đúng 15 fail Windows baseline, 0 fail trong `tests/migrate.test.ts`).
