# P4-FIX-F · Victor · Agent chạy code ngoài lượt (review 3: C1 C2 – High)

Chi tiết: team/reviews/P4-review-3.md. Viết test TRƯỚC (thấy FAIL) rồi sửa. Giữ nguyên guard FIX-D/E.

1. **C1 – cấu hình git độc.** Agent ghi `.git/config` (`commit.gpgSign`+`gpg.program`, `filter.*.clean/smudge`, `merge.*.driver`, `core.*` lạ) hoặc `.git/info/attributes` → chính BTM chạy script đó khi commit/checkout/merge.
   - `snapshotTurn` lưu nội dung `.git/config` + `.git/info/attributes` (thiếu = rỗng); `guardAgentTurn` khôi phục đúng bản cũ TRƯỚC mọi lệnh git khác, có thay đổi → vi phạm `git_config_tampered`.
   - git.ts thêm `-c commit.gpgSign=false -c tag.gpgSign=false`.
   - Test: lượt agent thêm gpg.program/clean filter → sau guard config như cũ, script KHÔNG chạy khi BTM commit (file đánh dấu không xuất hiện), có vi phạm.
2. **C2 – gate chạy code Dev không có guard.** Bọc `runGate` (lượt dev, session.ts ~969) bằng snapshotTurn + guardAgentTurn seat `qc` (không được commit/đổi gì). Ghim sha nhánh bảo vệ trong store (setting `protected_sha:<repo>`): đặt khi migrate/approveGoal/lần đầu; `snapshotTurn` và `approveGoal` so với giá trị ghim, lệch → khôi phục về sha ghim + vi phạm `protected_branch_moved`.
   - Test: lệnh gate (`node -e` gọi `git update-ref refs/heads/main <sha khác>`) → sau lượt main về sha ghim, phiên `needs_owner` có lý do; lượt sau KHÔNG coi main bẩn là gốc.

Scope: src/git.ts, src/core/guard.ts, src/core/session.ts, src/ticket/goal.ts, src/project/migrate.ts, src/store/db.ts (nếu cần), tests liên quan. Không giảm số test.
Xong khi: `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.
Báo cáo: team/reports/P4-FIXF-dev.md (≤10 dòng, con số thật).
