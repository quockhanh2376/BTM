# P3-T6 · fix 1 · Victor

Code P3-T6 chạy đúng, Qeen OK. Chỉ gọn lại, không đổi hành vi:

1. `pmPrompt(goals, notes?, hasOpenspec = false)` – bỏ các dạng nhận boolean/object ở tham số 2 và object ở tham số 3.
2. `initProject(root, name, templatesFrom, opts: { runOpenspec?: RunOpenspecFn } = {})` – bỏ dạng truyền thẳng function.
3. `defaultRunOpenspec`: bỏ nhánh `openspec.cmd`/win32 (Node không spawn được `.cmd` khi không có shell; BTM chạy trên Linux). Chỉ `spawnSync('openspec', …)`.
4. Sửa test cho khớp (bỏ case `{ hasOpenspec: true }`).

Scope: src/core/prompts.ts, src/project/init.ts, tests/init.test.ts.
Xong khi: `npx tsc --noEmit` sạch, `npx vitest run` vẫn 21 fail như cũ.
Báo cáo: ghi đè `team/reports/P3-T6-dev.md`.
