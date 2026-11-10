# P4-FIX-H · Dev · Lỗi thực tế từ review 4 (D3 D4 D6 D7 D8 D9)

Chi tiết: team/reviews/P4-review-4.md. Test trước (thấy FAIL) rồi sửa. Giữ mọi guard cũ. D1 D2 D5 KHÔNG làm (để plan cách ly agent).

1. **D3** host.ts: lệnh dev/qc trực tiếp – snapshot có `protectedBranchMoved` → từ chối lệnh (cancelled, lý do `protected_branch_moved`), KHÔNG chạy guard kéo main về.
2. **D4** recoverInterruptedTurn: main lệch sha trong snapshot tồn đọng → KHÔNG kéo main về, KHÔNG xoá file ignored; chỉ khôi phục nhánh goal + .git/config như cũ, trả needs_owner `recovered_interrupted_turn`.
3. **D6** host.ts: recover nằm trong try/finally sau acquireLock – lỗi thì vẫn releaseLock, log 1 dòng.
4. **D7** guard: .git/config chỉ khác ở `core.hooksPath` (husky `prepare`) → vẫn khôi phục nhưng KHÔNG tính `git_config_tampered`.
5. **D8** git.ts: thêm `-c safe.directory=*` vào mọi lệnh git của BTM (đã bỏ config global nên mất safe.directory).
6. **D9** dọn file ignored: chỉ xoá mục mới ở CẤP ĐẦU của thư mục ignored (đường dẫn mà phân đoạn đầu tiên chưa có trong snapshot, vd `dist/` mới → xoá cả `dist/`); file mới bên trong thư mục ignored đã có sẵn (vd `.venv/…`) → giữ. Liệt kê lỗi/quá lớn → note `ignored_list_failed` như hiện tại.

Scope: src/server/host.ts, src/core/guard.ts, src/git.ts, src/core/session.ts (nếu cần), tests liên quan. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch. (vitest có thể không chạy trong sandbox Codex – Cheki sẽ chạy.) Báo cáo: team/reports/P4-FIXH-dev.md (≤10 dòng).
