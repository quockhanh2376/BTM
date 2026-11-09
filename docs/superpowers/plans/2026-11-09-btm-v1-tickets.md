# BTM – Kế hoạch 4: BTM Tickets (Goal & Ticket) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy ở dự án này:** Cheki giao từng task cho **Victor** (Antigravity, dev) qua `team/board.md` + `team/prompts/P4-T<n>-victor.md`; **Qeen** (Antigravity, QC read-only) review; Cheki kiểm tra diff, commit, push, ghi `team/log.md`. Nhánh `plan4-tickets` (tạo từ `main` sau khi Plan 3 merge).

**Goal:** Thay thẻ `T-xxx` theo phiên bằng Goal `G<n>` + Ticket `<KEY>-<nnnn>` toàn project: PM chia ticket, Dev/QC làm theo số thứ tự, (tuỳ chọn) Kai audit, anh Zon duyệt merge goal vào `main` từ dashboard hoặc CLI.

**Architecture:** Ticket là file `team/tickets/<ID>.md` (repo là nguồn sự thật); SQLite giữ trạng thái goal/ticket + lịch sử đổi trạng thái theo **project** (không theo phiên). Mỗi goal một nhánh `goal/G<n>-<slug>`; phiên chạy lần lượt từng goal (PM → ticket theo `number`). Core cấp dải Ticket ID cho PM và kiểm tra; tổng kết goal `team/goals/G<n>.md` do Core sinh (không tốn token).

**Tech Stack:** như Kế hoạch 1–3 (Node 22, TS ESM, vitest, zod, yaml, better-sqlite3, node:http, HTML thuần).

**Spec:** `docs/tickets.md` (chuẩn chính, gồm §7) + `docs/decisions/0001-goal-ticket-system.md` + `docs/spec.md`.

**Lệch spec có chủ đích (Ruling):**
- Tổng kết goal `team/goals/G<n>.md` do Core sinh từ SQLite thay vì PM viết — tất định, không tốn lượt.
- Ticket ID: Core ghi trong prompt PM "ID bắt đầu từ `<KEY>-<nnnn>`"; PM tự đặt, Core kiểm tra (không trùng, ≥ số kế tiếp). Counter cập nhật = max đã nhận + 1.
- Bỏ hẳn luồng `T-xxx` (`team/tasks/`, `task_states`) khỏi code; bảng cũ giữ nguyên để không mất dữ liệu cũ, không đọc nữa.
- Fix ticket sau audit do **PM** viết (lượt PM nhận findings), Core không tự sinh nội dung ticket.

## Global Constraints

- `<KEY>`: `/^[A-Z]{2,5}$/`, đặt khi `btm init <name> --key <KEY>`, lưu `team/project.yaml` (`key: GTM`). Thiếu/sai → init từ chối.
- Ticket ID `/^[A-Z]{2,5}-\d{4}$/`, prefix phải đúng KEY của project; không reset theo goal, không dùng lại kể cả `cancelled`.
- Goal `G<n>` tăng dần theo project, không dùng lại.
- Front matter bắt buộc: `id, goal, number, of, title, type, size, scope, acceptance, done_when`; `type ∈ feat|fix|chore|security`; `size ∈ S|M|L`; `number ≤ of`; acceptance 1–5; scope đường dẫn trần (luật scope cũ của `card.ts`); tuỳ chọn `depends_on`, `note`, `openspec_change`, `from_audit` (mặc định false).
- Definition of Ready (Core kiểm trước khi giao Dev): đủ trường, size ≠ L, mọi `depends_on` đã `passed`. Không đạt → ticket `blocked`, lý do `not_ready: <chi tiết>`.
- Definition of Done: QC pass + báo cáo Dev/QC có dòng mã + mọi commit trong dải ticket bắt đầu bằng `<ID>: `.
- Dòng mã báo cáo: `<ID> · G<n>#<k>/<of> · <Tên>-<Ghế>` (vd `GTM-0012 · G1#3/9 · Jacky-Dev`), là dòng không rỗng đầu tiên.
- Nhánh goal: `goal/G<n>-<slug>`, slug ASCII thường, `[a-z0-9-]`, ≤ 30 ký tự, bỏ dấu tiếng Việt (`đ→d`), rỗng → `goal`.
- Chỉ anh merge (`git.merge_by: owner`): merge `--no-ff` goal → `main` chỉ khi goal `qc_done` (không có ghế audit) hoặc `audit_passed`.
- Ghế `audit` tuỳ chọn: không có `seats.audit` → bỏ qua bước audit. Coder của bất kỳ ticket nào trong goal không được ngồi audit goal đó.
- Mọi POST mới qua guard sẵn có (x-btm, Origin, JSON). Giao diện tiếng Việt, tương phản ≥ 4.5:1.
- `npx vitest run` không tăng số fail (Windows ~21 fail sẵn: symlink, process group, quoting POSIX) + `npx tsc --noEmit` sạch.

## Review Focus

1. **PM ghi ticket sai luật** (ID trùng/đã dùng/sai KEY, `number` > `of`, trùng `number` trong goal, size L) → từ chối toàn bộ đợt ticket đó, phiên `needs_owner` với lý do, không ticket nào được giao. (Task 1, Task 6)
2. **Tiêu đề goal tiếng Việt/ký tự lạ** (`"UI đăng nhập + reset pass!!"`) → nhánh hợp lệ `goal/G1-ui-dang-nhap-reset-pass`; `git check-ref-format` chấp nhận. (Task 1)
3. **Goal chạy qua nhiều phiên** (phiên 1 dừng giữa chừng) → phiên 2 checkout lại đúng nhánh goal, ticket `passed` không chạy lại, counter ID không reset. (Task 2, Task 6)
4. **Duyệt merge bị conflict** → `git merge --abort`, `main` không đổi, goal giữ trạng thái cũ, lỗi hiện cho anh. (Task 8)
5. **Duyệt merge khi goal chưa sẵn sàng / POST từ trang lạ** → 409 / 403, không merge. (Task 8, Task 9)

---

## File Structure

- Create `src/ticket/ticket.ts` – schema, parse, load, DoR, dòng mã báo cáo.
- Create `src/ticket/goal.ts` – slug, tên nhánh, đọc KEY, sinh `team/goals/G<n>.md`, duyệt/merge goal.
- Create `src/audit/result.ts` – parse kết quả audit.
- Modify `src/store/db.ts` – bảng `goals`, `tickets`, `ticket_history`, `project_counters`.
- Modify `src/project/init.ts`, `src/cli.ts` – `--key`, `team/tickets/`, `team/goals/`, lệnh `btm goal`.
- Modify `src/core/prompts.ts`, `src/core/session.ts`, `src/gate/gate.ts`, `src/qc/result.ts`, `src/config.ts`.
- Modify `src/server/snapshot.ts`, `src/server/http.ts`, `src/server/host.ts`, `web/index.html`.
- Delete `src/task/card.ts` + `tests/card.test.ts` (luật scope chuyển sang `ticket.ts`).

---

### Task 1: Ticket – schema, đọc file, Definition of Ready

**Files:** Create `src/ticket/ticket.ts`, `src/ticket/goal.ts` (chỉ `slugify`, `goalBranch`), `tests/ticket.test.ts`. (Giữ `card.ts` tới Task 6 rồi xoá.)

**Interfaces – Produces:**
- `slugify(title: string): string`, `goalBranch(n: number, title: string): string` → `goal/G<n>-<slug>` (`normalize('NFD')` bỏ `\p{M}`, `đ/Đ→d`).
- `type TicketType = 'feat'|'fix'|'chore'|'security'`, `type TicketSize = 'S'|'M'|'L'`
- `type TicketState = 'pending'|'in_dev'|'awaiting_qc'|'passed'|'returned'|'failed'|'blocked'|'cancelled'`
- `interface Ticket { id; goal: string /* "G1" */; number: number; of: number; title; type; size; scope: string[]; acceptance: string[]; done_when; depends_on: string[]; from_audit: boolean; note?; openspec_change? }`
- `parseTicket(md: string, key: string): Ticket` (ném `TicketError`)
- `loadTickets(repo: string, key: string, goal?: string): Ticket[]` – đọc `team/tickets/*.md`, bỏ symlink, sort theo `goal` rồi `number`; ném nếu trùng `id` hoặc trùng `number` trong cùng goal.
- `checkReady(t: Ticket, stateOf: (id: string) => TicketState | null): string[]` – trả danh sách lý do, rỗng = ready.
- `reportHeader(t: Ticket, agentName: string, seatLabel: 'Dev'|'QC'|'Audit'): string`

- [x] **Step 1: Test** `tests/ticket.test.ts`:
  - ticket mẫu ở `docs/tickets.md` §3 (thêm `type: feat`, `size: M`) parse đúng; `depends_on` mặc định `[]`, `from_audit` mặc định `false`.
  - `id: XYZ-0001` khi key `GTM` → ném; `number: 10, of: 9` → ném; acceptance 0 hoặc 6 mục → ném; `type: bug` → ném; scope `../x` → ném.
  - `loadTickets` 2 file cùng `G1` number 3 → ném `duplicate number`.
  - `checkReady`: size L → `['size_L']`; depends_on chưa passed → `['depends_on:GTM-0010']`; đủ → `[]`.
  - `reportHeader(t, 'Jacky', 'Dev') === 'GTM-0012 · G1#3/9 · Jacky-Dev'`.
  - `goalBranch(1,'UI đăng nhập + reset pass!!') === 'goal/G1-ui-dang-nhap-reset-pass'`; `slugify('!!!') === 'goal'`; tiêu đề 80 ký tự → slug ≤ 30, không kết thúc bằng `-`; `git check-ref-format --branch` chấp nhận kết quả.
- [x] **Step 2–4:** FAIL → implement (zod, tái dùng luật scope của `card.ts`) → PASS.
- [x] **Step 5:** Commit `feat: ticket schema, loader, definition of ready (P4 Task 1)`.

### Task 2: Store – goals, tickets, lịch sử, bộ đếm

**Files:** Modify `src/store/db.ts`, `tests/store.test.ts`.

**Interfaces – Produces (thêm vào `Store`):**
- `type GoalState = 'open'|'in_progress'|'qc_done'|'audit_passed'|'approved'|'merged'`
- `createGoal(project: string, title: string): { n: number; branch: string }` – n = max+1 theo project; branch = `goalBranch(n, title)` (Task 1).
- `getGoal(project, n)`, `listGoals(project): GoalRow[]` (`{n,title,state,branch,created_at,updated_at}`), `setGoalState(project, n, state, by, reason?)`.
- `upsertTicket(project, t: Ticket)` (giữ state hiện có), `getTicketState(project, id): {state, fix_rounds, base_sha} | null`.
- `setTicketState(project, id, to: TicketState, by: string, reason: string, fixRounds?: number, baseSha?: string|null)` – ghi `tickets` + 1 dòng `ticket_history(project, ticket_id, from_state, to_state, by, reason, at)`.
- `listTickets(project, goal?)`, `ticketHistory(project, id)`.
- `nextTicketSeq(project): number` (bắt đầu 1), `bumpTicketSeq(project, usedMax: number)` – counter = max(counter, usedMax+1), không bao giờ giảm.

- [x] **Step 1: Test:** tạo G1, G2 → n 1, 2; project khác bắt đầu lại 1. `setTicketState` pending→in_dev→passed tạo 2 dòng history đúng from/to/by/reason. `bumpTicketSeq(p, 12)` rồi `bumpTicketSeq(p, 5)` → `nextTicketSeq` = 13. Mở lại DB (close/open) giữ nguyên counter và state.
- [x] **Step 2–4:** FAIL → implement (`CREATE TABLE IF NOT EXISTS`, khoá `(project, n)` / `(project, id)`) → PASS.
- [x] **Step 5:** Commit `feat: store goals, tickets, history, id counter (P4 Task 2)`.

### Task 3: Init project với KEY

**Files:** Modify `src/project/init.ts`, `src/cli.ts`, `tests/init.test.ts`; Create helper `readProjectKey` trong `src/ticket/goal.ts`.

**Interfaces – Produces:** `initProject(root, name, templatesFrom, opts: { key: string; runOpenspec?: … })`; `readProjectKey(repo: string): string` (đọc `team/project.yaml`, ném nếu thiếu/sai).

- [x] **Step 1: Test:** `btm init moon --key GTM` → có `team/project.yaml` (`key: GTM`), `team/tickets/`, `team/goals/`, **không** có `team/tasks/`; thiếu `--key` hoặc `--key gtm`/`--key TOOLONG` → exit 1, không tạo thư mục. `readProjectKey` trên project thiếu file → ném.
- [x] **Step 2–4:** FAIL → implement → PASS. Giữ nguyên phần OpenSpec của P3-T6.
- [x] **Step 5:** Commit `feat: project key on init (P4 Task 3)`.

### Task 4: Gate – commit có mã ticket, dòng mã báo cáo

**Files:** Modify `src/gate/gate.ts`, `src/git.ts` (nếu cần helper log); test `tests/gate.test.ts`.

**Interfaces – Produces:**
- `commitsMissingTicketId(repo, base, id): string[]` – trả sha các commit `base..HEAD` có subject không bắt đầu bằng `<id>: `.
- `reportHeaderOk(repo, t: Ticket): boolean` – dòng không rỗng đầu tiên của `team/reports/<id>-dev.md` bắt đầu bằng `<ID> · G<n>#<k>/<of> · ` (bỏ qua tên agent); thiếu file → false.
- `runGate` **chưa đổi chữ ký** ở task này (session còn dùng `TaskCard` tới Task 6). Task 6 đổi `runGate` sang `Ticket` và thêm lý do `commit_missing_ticket_id`, `report_header_invalid` dùng 2 hàm trên.

- [x] **Step 1: Test:** `commitsMissingTicketId`: commit `GTM-0012: x` → `[]`; thêm commit `WIP x` → trả đúng sha đó; commit `GTM-00123: x` (ID khác) → bị trả. `reportHeaderOk`: dòng đầu `GTM-0012 · G1#3/9 · Jacky-Dev` → true; `OK` → false; dòng trống đầu file rồi header → true; thiếu file → false.
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** Commit `feat: ticket id in commits, report header gate (P4 Task 4)`.

### Task 5: Prompt PM/Dev/QC + kết quả QC theo ticket

**Files:** Modify `src/core/prompts.ts`, `src/qc/result.ts`; tests `tests/prompts.test.ts` (mới nếu chưa có), `tests/qc.test.ts`.

**Interfaces – Produces** (hàm MỚI, tên mới; hàm cũ `pmPrompt/devPrompt/qcPrompt/parseQcResult` giữ nguyên tới Task 6 để `tsc` không gãy – Task 6 chuyển session sang hàm mới rồi xoá hàm cũ):
- `interface AuditFinding { ticket: string; severity: 'high'|'medium'|'low'; text: string }` – đặt ở `src/ticket/ticket.ts` (Task 7 dùng lại).
- `pmTicketPrompt(g: { n: number; title: string }, key: string, nextId: string /* "GTM-0013" */, opts?: { notes?: Array<string | PromptNote>; hasOpenspec?: boolean; auditFindings?: AuditFinding[] })`
- `devTicketPrompt(t: Ticket, agentName: string, fixNotes?: string[], allow?: string[], handoff?: boolean)`, `qcTicketPrompt(t: Ticket, base: string, agentName: string)`
- `parseTicketQcResult(text, expect: { ticket: string; goal: string; number: number }): QcResult` – JSON phải có `ticket/goal/number` khớp, sai → `fail` + `qc_output_invalid`.

- [x] **Step 1: Test:** pmTicketPrompt chứa `team/tickets/`, `G1`, `GTM-0013`, các trường bắt buộc + `type`/`size`, "size L phải tách"; có `auditFindings` → dòng yêu cầu ticket sửa `from_audit: true`. devTicketPrompt/qcTicketPrompt chứa `team/tickets/GTM-0012.md` và đúng chuỗi `reportHeader`. QC JSON thiếu `ticket` hoặc `number` lệch → `verdict: 'fail'`, `fix` có `qc_output_invalid`.
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** Commit `feat: ticket-aware prompts and qc result (P4 Task 5)`.

### Task 6: Phiên chạy theo goal

**Files:** Modify `src/core/session.ts`, `src/cli.ts`, `src/server/host.ts`; tests `tests/session.test.ts`, `tests/host.test.ts`; Delete `src/task/card.ts`, `tests/card.test.ts`.

**Interfaces – Consumes:** Task 1–5. **Produces:** `runSession(d, goals: Array<string | { n: number }>)` – chuỗi = goal mới, `{n}` = tiếp tục goal cũ; CLI `btm run --goal "<tiêu đề>"` / `--goal-id G1`.

Luồng mỗi goal (tuần tự, chung giới hạn lượt của phiên):
1. Goal mới → `createGoal`; checkout `goal/G<n>-<slug>` (tạo từ `main` nếu chưa có). Goal → `in_progress`.
2. Chưa có ticket nào cho goal → lượt PM (`pmTicketPrompt`; session dùng `devTicketPrompt`/`qcTicketPrompt`/`parseTicketQcResult`, xoá 4 hàm cũ); PM chỉ được ghi `team/tickets/`; `loadTickets(goal)` lỗi hoặc ID < `nextTicketSeq`/sai KEY → `needs_owner` (lý do rõ), không giao Dev. Ok → `upsertTicket` từng cái (state `pending`, by `pm`), `bumpTicketSeq`, commit `<ID đầu>..<ID cuối>: PM tickets for G<n>`.
3. Duyệt thẻ (`require_task_approval`) như cũ nhưng theo goal.
4. Ticket theo `number`, bỏ `passed`/`cancelled`; `checkReady` lỗi → `blocked`. `runGate(repo, ticket: Ticket, …)` thay `TaskCard`, thêm lý do `commit_missing_ticket_id` + `report_header_invalid` (hàm Task 4). Dev → gate → QC như Kế hoạch 1–3, mọi commit Core đổi thành `<ID>: …` (vd `GTM-0012: WIP timeout`), mọi đổi trạng thái qua `setTicketState(by = agent id, reason)`.
5. Mọi ticket goal `passed` → goal `qc_done`; Core ghi `team/goals/G<n>.md` (bảng: number, ID, tiêu đề, trạng thái, vòng sửa) và commit `G<n>: summary`.

- [ ] **Step 1: Test** (runner giả): goal mới tạo đúng nhánh, PM ghi 2 ticket → Dev/QC chạy theo number, goal `qc_done`, có `team/goals/G1.md`, mọi commit trong nhánh bắt đầu bằng `GTM-` hoặc `G1:`. PM ghi ID trùng → `needs_owner`, không lượt Dev. Phiên 2 `--goal-id G1` sau khi phiên 1 dừng sau ticket 1 → chỉ chạy ticket 2, counter không reset. Ticket depends_on ticket `failed` → `blocked` với `not_ready`. Hết lượt giữa goal → `out_of_turns` như cũ.
- [ ] **Step 2–4:** FAIL → implement → PASS (xoá `card.ts` + import cũ; `tsc` sạch).
- [ ] **Step 5:** Commit `feat: sessions run goals and tickets (P4 Task 6)`.

### Task 7: Ghế audit (Kai) – tuỳ chọn

**Files:** Modify `src/config.ts`, `src/core/prompts.ts`, `src/core/session.ts`; Create `src/audit/result.ts`; tests `tests/config.test.ts`, `tests/audit.test.ts`, `tests/session.test.ts`.

**Interfaces – Produces:**
- `Seat` thêm `'audit'`; `seats.audit` và `max_turns_per_seat.audit`, `timeout_minutes.audit` **tuỳ chọn** (thiếu = không audit).
- `AuditFinding` (Task 5, src/ticket/ticket.ts); `parseAuditResult(text): { verdict: 'pass'|'fail'; findings: AuditFinding[] }` – JSON lỗi → `fail` + finding `audit_output_invalid`; có `high`/`medium` mà verdict `pass` → ép `fail`.
- `auditPrompt(goal: {n,title}, base: string /* merge-base main */, ticketIds: string[], agentName)` – read-only, checklist `docs/tickets.md` §5, ghi `team/reports/G<n>-audit.md`.

Luồng: goal `qc_done` + có ghế audit → agent audit ≠ mọi coder của goal (vi phạm → `needs_owner`) → `pass` → `audit_passed`; `fail` → lượt PM với `auditFindings` → ticket mới `from_audit: true`, `of` tăng cho ticket mới → chạy tiếp bước 4 Task 6.

- [ ] **Step 1: Test:** config không có `audit` vẫn load, phiên bỏ qua audit; audit pass → `audit_passed`; audit fail high → PM nhận findings, ticket mới `G1#3/3` `from_audit: true` chạy rồi audit lại; coder ngồi ghế audit → `needs_owner`; output audit rác → fail.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: optional audit seat (P4 Task 7)`.

### Task 8: Duyệt & merge goal

**Files:** Modify `src/ticket/goal.ts`, `src/cli.ts`; test `tests/goal.test.ts`, `tests/init.test.ts`.

**Interfaces – Produces:** `approveGoal(store, repo, cfg, n: number, by = 'owner'): { ok: true; sha: string } | { ok: false; code: 'not_ready'|'busy'|'conflict'|'dirty'; message: string }`. CLI: `btm goal list`, `btm goal approve G1`.

- Chỉ nhận khi goal `qc_done` (không có ghế audit) hoặc `audit_passed`; working tree sạch; không có phiên chạy (khoá `btm.lock`).
- `approved` → `git checkout main` → `git merge --no-ff goal/... -m "G<n>: <tiêu đề>"` → `merged`. Conflict → `merge --abort`, quay về nhánh cũ, goal giữ trạng thái, `code: 'conflict'`.
- [ ] **Step 1: Test:** goal `in_progress` → `not_ready`; goal `qc_done` → main có merge commit, goal `merged`; conflict giả (sửa cùng dòng trên main) → `conflict`, `git rev-parse main` không đổi. CLI `approve G9` không tồn tại → exit 1.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: owner approves and merges goals (P4 Task 8)`.

### Task 9: Dashboard – bảng theo goal, pipeline, lịch sử, nút Duyệt merge

**Files:** Modify `src/server/snapshot.ts`, `src/server/http.ts`, `src/server/host.ts`, `web/index.html`; tests `tests/snapshot.test.ts`, `tests/http.test.ts`, `tests/web.test.ts`.

**Interfaces – Produces:**
- Snapshot thêm `goals: Array<{ n; title; state; stage: 'intake'|'plan'|'build'|'verify'|'audit'|'release'; passed: number; total: number; tickets: Array<{ id; number; of; title; type; size; state; fix_rounds }> }>`; `seats[].ticket` = Ticket ID đang làm.
- Stage: `open`→intake, có PM đang chạy/chưa ticket→plan, có ticket `in_dev`/`returned`→build, `awaiting_qc`→verify, `qc_done` có ghế audit→audit, `qc_done`(không audit)/`audit_passed`/`approved`/`merged`→release.
- `GET /api/tickets/<id>/history` → `ticketHistory`; `POST /api/goal/approve {goal: "G1"}` → `approveGoal`; `not_ready`/`busy` → 409, `conflict`/`dirty` → 409 kèm message.
- Web: thanh pipeline 6 chặng tiếng Việt (Tiếp nhận · Lập kế hoạch · Đang làm · Kiểm thử · Kiểm tra bảo mật · Phát hành); mỗi goal một nhóm tiêu đề `G1 · <tiêu đề> · 6/9 đạt`; dòng ticket `#3/9 · GTM-0012`; bấm dòng → dòng thời gian lịch sử; nút `<button>` **Duyệt merge** chỉ hiện khi goal sẵn sàng, có hộp xác nhận.
- [ ] **Step 1: Test:** snapshot từ store có 1 goal 2 ticket (1 passed) → `passed 1 / total 2`, stage đúng từng trạng thái; POST approve thiếu `x-btm` → 403; goal chưa sẵn sàng → 409; history trả đúng thứ tự thời gian; web có đủ 6 nhãn chặng và nút Duyệt merge là `<button>`; tương phản nhãn chặng ≥ 4.5:1 cả hai theme.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: dashboard goals, pipeline, ticket history, approve merge (P4 Task 9)`.

---

## Để sau (không làm trong kế hoạch này)

Ưu tiên P0–P2, deadline/SLA, nhiều người một ticket, đồng bộ Jira/GitHub Issues (`docs/tickets.md` §7); chọn công cụ CLI cho Kai; chạy song song (v2.0).
