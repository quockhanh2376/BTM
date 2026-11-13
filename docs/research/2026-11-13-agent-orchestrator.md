# agent-orchestrator (Orchestrator.inc) so với BTM

- Ngày: 2026-11-13 · Người đọc: Cheki · Nguồn: https://github.com/OrchestratorInc/agent-orchestrator (Apache-2.0, ~14.5k sao). Đã đọc README, CONTEXT.md, `docs/architecture.md`, ADR 0002 (reviewer gateway) và `backend/pkg/agentruntime/command.go`. Chưa cài thử.

## Họ là gì
Daemon Go chạy cục bộ, có app desktop (Electron), app mobile và CLI `ao`. Một **agent điều phối** (LLM) chia việc và mở nhiều worker **song song**. Mỗi worker có worktree và nhánh riêng, kết quả là một PR trên GitHub. Lỗi CI, comment review và conflict của PR được gửi lại cho đúng worker. Hỗ trợ hơn 35 agent CLI. Có telemetry gửi về PostHog (kèm GitHub username), tắt được.

## Giống BTM
- Đều điều khiển CLI agent có sẵn (Claude Code, Codex, Agy), không tự làm model.
- Đều có dashboard với SSE và lưu trạng thái bằng SQLite.
- Đều cách ly agent khỏi `main` bằng nhánh hoặc worktree riêng.
- Đều báo người khi cần (push mobile / ntfy).

## Khác BTM
| | agent-orchestrator | BTM |
|---|---|---|
| Hình dạng | App desktop, mobile, cloud | Server trên VM, dashboard web qua tunnel SSH |
| Điều phối | Agent LLM tự chia việc, chạy song song | Code của core theo luật cố định; PM chỉ viết ticket; Dev → QC tuần tự, cả goal xong thì Audit |
| Vai trò | Worker đa năng, có thể thêm reviewer agent | Ghế PM / Dev / QC / Audit; người code không được QC hay audit việc của mình |
| Cổng kiểm tra | CI và review trên PR GitHub | Cổng ngay trong BTM (scope, report, commit) + QC + audit bắt buộc + anh Approve |
| Kết quả | PR mỗi task | Nhánh goal → merge `main` → push + tag (decision 0006) |
| Quyền agent | Chạy dưới user của người dùng; có `bypassPermissions` (Claude) và mặc định `--dangerously-bypass-approvals-and-sandbox` (Codex) | Mỗi agent một user Linux, không API key, không skip-permissions, `main` được ghim, guard kiểm git config |
| Tài khoản | Mỗi agent một đăng nhập | Nhiều tài khoản cho mỗi Worker, theo dõi Energy, tự đổi khi hết quota |
| Số agent | 35+ | 3 |

## Nên lấy (đưa vào Kế hoạch 8)
1. **Lỗi sau khi push quay về team:** họ gửi lỗi CI và comment review về đúng worker. BTM có thể đọc kết quả CI của commit đã push và giao việc sửa. Riêng comment review cần PR, mà PR cần token, nên để sau.
2. **Trạng thái hiển thị tính khi đọc:** họ chỉ lưu dữ kiện gốc (`activity_state`, dữ kiện PR) và suy ra trạng thái hiển thị. Ở BTM, chip Energy và nút Resume đang lệch thực tế.
3. **Reviewer thật sự chỉ đọc** (ADR 0002): reviewer không bao giờ chạy trong checkout có quyền ghi. Ở BTM, Bruno (audit) đang chạy Codex với `workspace-write`, và Claude ở ghế audit có Edit/Write.
4. **Chạy song song** các ticket độc lập, mỗi ticket một nhánh riêng.

## Không lấy
- Agent LLM tự điều phối (mất luật cứng của BTM), chế độ bypass quyền, telemetry, cloud workspace.
