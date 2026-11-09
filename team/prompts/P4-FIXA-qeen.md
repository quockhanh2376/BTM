# P4-FIX-A · Qeen · Review an toàn git quanh lượt agent

Đọc: team/reviews/P4-review-1.md (#1 #2 #3 #4 #8), team/prompts/P4-FIXA-victor.md, team/prompts/P4-FIXA-fix1-victor.md, team/reports/P4-FIXA-dev.md. Đọc kỹ `guardAgentTurn` và mọi chỗ gọi nó trong src/core/session.ts.

**Kiểm:**
1. Mọi lượt agent (pm, dev, qc, audit) – cả nhánh thành công, timeout, lỗi, abort, throw – đều đi qua guard. Liệt kê chỗ nào bị sót.
2. Không có `reset --hard` / `clean` / `checkout --` nào có thể chạy khi HEAD không ở nhánh goal.
3. Agent commit lên main → main được trả về đúng sha; agent đổi nhánh → quay về nhánh goal.
4. qc/audit không bao giờ để lại commit WIP chứa thay đổi của chính nó.
5. Đầu phiên tree bẩn → needs_owner, không commit.
6. Không có test bị xoá; `npx tsc --noEmit` sạch; `npx vitest run` đúng 15 fail Windows.

**Báo cáo:** team/reports/P4-FIXA-qeen.md
