# P4-FIX-G vòng 3 · Dev · Đơn giản hoá C8 + 1 lỗi approve

Bối cảnh: cây làm việc đang có diff FIX-G (C3–C8, chưa commit, test xanh). Reviewer độc lập thấy C8 vừa chặn nhầm việc hợp lệ vừa dễ lách. Cheki chốt hướng ĐƠN GIẢN (giữ nguyên C3–C7):

1. **Bỏ hẳn kiểm `node_modules/.bin`** và mọi thứ chỉ phục vụ nó: `nodeModulesBin`, `hadNodeModules`, `pkgManifestHashes`, `snapshotNodeModulesBin`, `snapshotPkgManifests`, `didPkgManifestsChange`, `PKG_MANIFEST_FILES`, vi phạm `ignored_file_planted` và `ignoredFilePlanted` ở src/core/guard.ts, src/core/session.ts, src/server/host.ts. Thêm 1 dòng comment ở guard: `// shortcut: không phát hiện agent sửa file trong node_modules; khi cần thì gate chạy trên bản checkout sạch + npm ci.`
2. **Dọn file ignored mới** (giữ hành vi xoá im lặng + note `ignored_cleaned:<n>`), sửa cách liệt kê:
   - Một lệnh: `git ls-files --others --ignored --exclude-standard --directory -z -- . ':(exclude,glob)**/node_modules/**' ':(exclude)node_modules'` (KHÔNG truyền tên file ở gốc làm pathspec – tên như `:(bad)` làm git lỗi và tắt việc dọn).
   - Lệnh lỗi → coi là có vấn đề: KHÔNG trả `[]` im lặng; ghi note `ignored_list_failed` và vẫn chạy tiếp.
   - `node_modules` ở mọi cấp (monorepo `packages/x/node_modules`) không bao giờ bị xoá.
3. **src/ticket/goal.ts ~217**: `catch {}` khi đọc `git log` lệnh trực tiếp → trả `not_ready` (fail-closed), không cho approve.
4. Tests: xoá/sửa test chỉ dành cho `.bin`/`ignored_file_planted` (được phép – tính năng bị bỏ); thêm test: file `:(bad)` ở gốc + `.env` mới → `.env` vẫn bị dọn; `packages/x/node_modules/a.js` mới → còn nguyên; `dist/x.js` mới → bị dọn trước gate, ticket vẫn pass; approve khi git log lỗi → not_ready. Ngoài phần `.bin`, không giảm test.

Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows. Báo cáo: ghi đè team/reports/P4-FIXG-dev.md (≤10 dòng, con số thật).
