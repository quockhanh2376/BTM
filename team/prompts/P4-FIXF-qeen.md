# P4-FIX-F · Qeen · Review (read-only)

Đọc team/prompts/P4-FIXF-victor.md + P4-FIXF2-victor.md + team/reviews/P4-review-3.md (C1, C2) và `git diff`.
Kiểm: (1) agent sửa .git/config / .git/info/attributes / ~/.gitconfig trong lượt → BTM không chạy script khi commit/checkout/merge; (2) gate chạy trong guard, main đổi trong gate bị khôi phục; (3) main đổi NGOÀI BTM → phiên dừng needs_owner, KHÔNG tự reset; `btm main accept` ghim lại; (4) approveGoal cập nhật sha ghim sau merge (nếu không, phiên sau sẽ báo main moved sai); (5) không xoá/giảm test cũ.
Chạy `npx tsc --noEmit`, `npx vitest run` (đúng 15 fail Windows).
Báo cáo: team/reports/P4-FIXF-qeen.md – Bug / Cần sửa / Cần xác nhận (≤10 dòng), ổn: "OK".
