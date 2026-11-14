# Bản đồ kiến thức project – kế hoạch

> Thực hiện: Native (Cheki làm trong phiên).

**Goal:** dựng bản đồ module + lịch sử sửa file từ code, đưa đúng phần cho PM/Dev/QC, xem được trên dashboard.
**Spec:** docs/superpowers/specs/2026-11-14-project-map-design.md

## Ràng buộc
- Không AI, không commit vào repo; lỗi dựng bản đồ không làm hỏng lượt (trả chuỗi rỗng).
- Đọc tối đa 64 KB mỗi file, tối đa 400 file; bỏ nhị phân, `team/`, `node_modules/`.
- PM ≤ 4.000, Dev ≤ 1.500, file lưu ≤ 12.000 ký tự. Web hiện bằng textContent.

## Review Focus
1. Repo không có team/tickets hoặc ticket lỗi YAML → vẫn có phần module, không throw.
2. Scope là thư mục (`public/js/`) → khớp mọi file bên trong.
3. File rất lớn / nhị phân / không đọc được → bỏ qua symbol, vẫn liệt kê.
4. Ticket hiện tại không tự liệt kê chính nó trong "ticket cũ cùng file".
5. Bản đồ dài → cắt đúng giới hạn, có dấu "…".

### Task 1: `src/knowledge/map.ts` + test
- `fileSymbols(text: string, path: string): { note: string; symbols: string[] }`
- `touchedBy(tickets: Ticket[]): (file: string) => string[]`
- `buildProjectMap(store, repo, max?): string`, `mapForScope(repo, scope: string[], selfId?, max?): string`, `regressionTickets(repo, t: Ticket): string[]`, `saveProjectMap(store, cfg, repo): string | null`
### Task 2: prompts
- `pmTicketPrompt` opts `map?`; `devTicketPrompt(..., map = '')`; `qcTicketPrompt(..., regress: string[] = [])`; nối ở pm-planning / dev-turn / qc-turn.
### Task 3: route + nút Map + search + lưu khi duyệt goal
### Task 4: kiểm tra, VM ×3, PR, merge
