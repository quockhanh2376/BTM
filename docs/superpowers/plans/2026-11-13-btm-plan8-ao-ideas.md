# BTM – Kế hoạch 8: Ý tưởng từ agent-orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy:** Cheki code từng task trên nhánh riêng (`plan8-<task>`), test VM ×3, review độc lập cuối mỗi task, rồi tự merge. Deploy/restart VM hỏi anh Zon. Mỗi task là một PR; làm theo thứ tự 1 → 4 (task sau dựa vào task trước). **Không làm Task 3, 4 khi vòng GameTest-BTM G1 đang chạy.**

**Goal:** Đưa 4 ý từ agent-orchestrator vào BTM: (1) audit thật sự chỉ đọc, (2) trạng thái hiển thị tính từ dữ kiện để không lệch, (3) kết quả CI trên GitHub sau khi push quay về team, (4) nhiều Dev làm song song các ticket độc lập.

**Architecture:** Gắn vào chỗ có sẵn: quyền theo ghế ở `buildArgv` + `ConfigSchema`; trạng thái suy ra ở `snapshot.ts` + chặn ở `host.resume`; CI đọc qua REST công khai của GitHub, lưu cạnh `ReleaseInfo` (`src/release/`); song song bằng nhánh ticket + khoá nhập lượt quanh `importTurn` trong `processGoal`. Không đổi mô hình cách ly user Linux, không thêm API key.

**Tech Stack:** như Kế hoạch 1–7 (Node 22 + TS ESM, vitest, better-sqlite3).

**Spec:** `docs/research/2026-11-13-agent-orchestrator.md` (mục "Nên lấy" 1–4) + `docs/superpowers/specs/2026-11-13-goal-release-design.md` + decision 0006.

## Global Constraints

- Vẫn **không API key / token GitHub** (decision 0003/0006). CI chỉ đọc qua REST **không xác thực** của repo **public**; repo private → trạng thái `unavailable`, không lỗi.
- Không bao giờ `--dangerously-skip-permissions`, `bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`.
- Luật cứng giữ nguyên: người code ≠ QC ticket đó, ≠ Audit goal; agent không đổi được ghế; dữ liệu agent viết ra (kể cả tên job CI trong workflow do agent viết) là **không tin cậy**: lọc ký tự, cắt độ dài, hiển thị bằng `textContent`.
- Mọi tính năng mới **tắt mặc định** qua config (hành vi cũ giữ nguyên khi không bật), trừ Task 1 (sửa lỗ hổng: bật luôn).
- API mới: `x-btm: 1`, chỉ `127.0.0.1`, đang có lượt chạy → 409 nếu đổi trạng thái.
- Test không gọi CLI thật / mạng thật (fetch giả); `npx vitest run` không tăng số fail (Windows baseline 15 fail + 3 skip); `npx tsc --noEmit` không thêm lỗi; VM ×3 xanh.

## Review Focus

1. **Audit vẫn ghi được file** qua một công cụ khác (agy không có chế độ chỉ đọc) → agy bị cấm ngồi `qc`/`audit` ở bước kiểm config; Codex/Claude ở ghế audit có argv chỉ đọc. (Task 1)
2. **Chip Energy báo còn nhiều trong khi tài khoản đang bị giới hạn**, hoặc số liệu cũ vài giờ vẫn hiện "fresh" → chip suy ra từ `usage_limited_until` + tuổi số liệu lúc đọc. (Task 2)
3. **Resume chạy khi không còn tài khoản dùng được** → nút tắt kèm lý do, server trả 409 `no_usable_account:<agent>` trước khi mở phiên. (Task 2)
4. **Workflow CI do agent viết lạm quyền trên repo public** (`permissions: write-all`, `pull_request_target`, secrets) → PM dặn file mẫu cố định `permissions: contents: read`; audit checklist thêm mục workflow; core từ chối push nếu `.github/workflows/*` có `pull_request_target` hoặc `permissions` khác `contents: read`. (Task 3)
5. **Hai Dev song song sửa cùng file** → ticket thứ hai merge vào nhánh goal bị conflict → không ghi đè: ticket đó `returned` với `merge_conflict`, Dev làm lại trên đỉnh nhánh goal mới. (Task 4)

---

### Task 1: Audit (và QC) thật sự chỉ đọc

Lỗi hiện tại (đọc code 2026-11-13): `buildArgv` cho Codex `--sandbox workspace-write` ở mọi ghế trừ `qc` → Bruno (audit) ghi được file; Claude ở ghế audit chạy `acceptEdits` + `Edit,Write`; agy không phân biệt ghế. Guard chỉ phát hiện **sau** lượt.

**Files:** Modify `src/runner/argv.ts`, `src/config.ts`; tests `tests/argv.test.ts`, `tests/config.test.ts`.

**Interfaces – Produces:**
- `const READ_ONLY_SEATS: ReadonlySet<Seat> = new Set(['qc', 'audit'])` trong `argv.ts`.
- Codex: `--sandbox read-only` khi `READ_ONLY_SEATS.has(o.seat)`.
- Claude: ghế chỉ đọc → `['claude', ...flags, '-p', prompt, '--allowedTools', 'Read,Grep,Glob']` (không `--permission-mode`, không Edit/Write/Bash).
- `ConfigSchema.superRefine`: agent `tool: antigravity-cli` có `qc` hoặc `audit` trong `can_sit` → lỗi `agy has no read-only mode; it cannot sit in <seat>`.

- [ ] **Bước 0:** Trên VM chạy `sudo -n -u btm-jacky /opt/btm-cli/bin/agy --help` (chỉ đọc help) để chắc agy không có chế độ chỉ đọc. Có thì ghi lại flag và dùng thay cho luật cấm; không có thì giữ luật cấm.
- [ ] **Bước 1: Test fail:** `buildArgv('codex-cli', 'p', { seat: 'audit', … })` chứa `'read-only'`, không chứa `'workspace-write'`; `buildArgv('claude-code', 'p', { seat: 'audit', … })` không chứa `'Edit'`, `'Write'`, `'acceptEdits'`; `loadConfig` với `kai: { tool: antigravity-cli, can_sit: [audit] }` ném lỗi chứa `no read-only mode`. Ghế `dev`/`pm` giữ argv cũ (snapshot test hiện có không đổi).
- [ ] **Bước 2:** Sửa `argv.ts`, `config.ts`. Sửa comment mẫu `kai` trong `btm.config.yaml` thành `can_sit: [dev]`.
- [ ] **Bước 3:** `npx vitest run tests/argv.test.ts tests/config.test.ts` xanh; full suite không tăng fail.
- [ ] **Bước 4:** Commit `fix: audit and QC seats run read-only (codex sandbox read-only, claude Read/Grep/Glob); agy cannot sit qc/audit`. VM ×3, merge. Deploy hỏi anh.

### Task 2: Trạng thái hiển thị suy ra từ dữ kiện

**Files:** Modify `src/server/snapshot.ts`, `src/server/host.ts`, `src/config.ts`, `web/index.html`, `docs/i18n-strings.md`; tests `tests/snapshot.test.ts`, `tests/host.test.ts`, `tests/web.test.ts`.

**Interfaces – Produces:**
- Config `energy.stale_minutes?: number` (mặc định 30).
- `SeatCard['energy'].status` thêm `'stale' | 'limited'`. `getSeatEnergy(store, key, cfg, now)`:
  - `usage_limited_until:<key>` còn hạn → `{ status: 'limited', minPercent: 0, soonestReset: until, warn: true }` (bỏ qua số liệu đọc).
  - `fresh` nhưng `now - readAt > stale_minutes` → `status: 'stale'` (giữ windows, `warn` vẫn tính).
- `Snapshot.session.canResume: boolean`, `Snapshot.session.resumeBlocked: string | null` – `no_usable_account:<agent>` khi một ghế đang có người (`effectiveSeats`) mà `usableAccounts(cfg, store, agent, now)` rỗng và `seats_backup` của ghế đó cũng rỗng tài khoản dùng được.
- `host.resume()` kiểm cùng hàm `resumeBlocker(cfg, store, now): string | null` (đặt trong `snapshot.ts`, export) → trả `{ ok: false, status: 409, error: blocker }` trước khi đổi trạng thái phiên.
- Dashboard: chip Energy hiện "Limited · resets HH:mm" / "Stale"; nút Resume `disabled` + `title` = lý do. Chuỗi mới: `energy.limited`, `energy.stale`, `btn.resumeBlocked`.

- [ ] **Bước 1: Test fail:** (a) tài khoản có `usage_limited_until` tương lai và energy fresh 90% → chip `limited`, `minPercent 0`; (b) energy fresh, `readAt` 2 giờ trước → `stale`; (c) mọi tài khoản dev bị giới hạn, không backup → `canResume false`, `resumeBlocked 'no_usable_account:jacky'`, và `host.resume()` trả 409, phiên vẫn `needs_owner`; (d) web: nút Resume dùng `state.session.canResume`.
- [ ] **Bước 2:** Code như Interfaces. Không lưu thêm cột/setting mới nào (chỉ suy ra).
- [ ] **Bước 3:** Test xanh, full suite, `tsc`.
- [ ] **Bước 4:** Commit, VM ×3, merge.

### Task 3: Kết quả CI trên GitHub quay về team

Chỉ chạy khi project có `release.github` (decision 0006) và lần push gần nhất `ok`.

**Files:** Create `src/release/ci.ts`; Modify `src/release/publish.ts`, `src/server/host.ts`, `src/server/http.ts`, `src/server/snapshot.ts`, `src/core/prompts.ts`, `src/notify/notify.ts`, `src/config.ts`, `web/index.html`, `docs/i18n-strings.md`, `docs/decisions/0006-github-push.md`; tests `tests/ci.test.ts`, `tests/release.test.ts`, `tests/host.test.ts`, `tests/http.test.ts`, `tests/prompts.test.ts`.

**Interfaces – Produces:**
- Config `release.ci?: { poll_seconds: number (mặc định 120), max_minutes: number (mặc định 40) }`; không có khối `ci` → không theo dõi CI.
- `ReleaseInfo` thêm `sha: string` và `ci?: { state: 'pending' | 'success' | 'failure' | 'none' | 'unavailable'; url?: string; failed: string[]; checkedAt: string }`.
- `fetchCi(target: string, sha: string, fetchFn = fetch): Promise<NonNullable<ReleaseInfo['ci']>>`:
  - `GET https://api.github.com/repos/<target>/actions/runs?head_sha=<sha>&per_page=20`, headers `Accept: application/vnd.github+json`, `User-Agent: btm`, **không** `Authorization`, timeout 10 s.
  - 0 run → `none`; còn run chưa `completed` → `pending`; có `conclusion` ∉ {success, skipped, neutral} → `failure` và gọi `GET …/actions/runs/<id>/jobs` lấy tên job + step lỗi; 403/404/429/lỗi mạng → `unavailable`.
  - `failed`: tối đa 5 mục, mỗi mục lọc `[^A-Za-z0-9 _.:/()-]` → bỏ, cắt 80 ký tự. `url` chỉ nhận `https://github.com/<target>/actions/runs/<số>`.
- Host: sau `pushRelease` ok → hẹn đọc CI mỗi `poll_seconds` tới khi `success|failure|none|unavailable` hoặc quá `max_minutes` (ghi `pending` cuối); huỷ hẹn khi `stop` hoặc process thoát. ntfy kind mới `ci_failed`, `ci_passed` (ALWAYS).
- `POST /api/goal/ci-fix {goal: "G<n>"}` → khi `ci.state === 'failure'` gọi `host.command('pm', text)` với text do **core** dựng từ mẫu cố định: `Sửa CI của G<n> (<tag>): các job lỗi: <failed nối bằng "; ">. Chạy lại npm test trên Windows và Linux cho xanh; tăng version bản vá.` Ngược lại 409.
- PM prompt (khi `docs_ticket` và project có `release.github`): ticket docs thêm `.github/workflows/ci.yml` **đúng mẫu**: `on: push`, `permissions: contents: read`, job `test` ma trận `ubuntu-latest, windows-latest`, `actions/setup-node` node 22, `npm test`.
- `publishGoal` từ chối (`error: 'workflow_unsafe'`) khi trên `main` có file `.github/workflows/*.yml` chứa `pull_request_target`, `secrets.`, hoặc `permissions:` khác `contents: read`. Audit prompt thêm mục "workflow CI: quyền, secrets, trigger".
- Dashboard thẻ goal: chip `CI ✓ / ✗ / … / –` (link run nếu có) và nút "Giao sửa CI" khi `failure`.

- [ ] **Bước 1: Test fail `tests/ci.test.ts`:** fetch giả trả (a) 0 run → `none`; (b) 1 run `in_progress` → `pending`; (c) run `failure` + jobs → `failure`, `failed` đã lọc ký tự lạ và cắt 80; (d) 403 → `unavailable`; (e) không bao giờ gửi header `Authorization`; (f) `url` lạ (không phải github.com) bị bỏ.
- [ ] **Bước 2: Test fail `release.test.ts`:** workflow có `pull_request_target` → `workflow_unsafe`, không push; workflow đúng mẫu → push.
- [ ] **Bước 3: Test fail host/http:** push ok → đọc CI theo hẹn (fake timers) đến `failure` → lưu + notify `ci_failed`; `/api/goal/ci-fix` khi failure gọi `command('pm', …)` với text mẫu; khi success → 409.
- [ ] **Bước 4:** Code. Ghi bổ sung vào decision 0006: đọc CI không xác thực, chỉ repo public, giới hạn 60 lượt/giờ/IP (40 phút × 1 lượt/2 phút = 20 lượt + jobs ≤ 5).
- [ ] **Bước 5:** Test xanh, full suite, `tsc`. Commit, VM ×3, merge. Deploy hỏi anh.

### Task 4: Nhiều Dev song song cho ticket độc lập

Mặc định tắt (`turn.parallel_dev: 1` = như cũ). Chỉ Dev song song; QC vẫn tuần tự từng ticket theo thứ tự xong.

**Files:** Modify `src/config.ts`, `src/core/session.ts`, `src/isolation/trusted.ts`, `src/server/snapshot.ts`, `web/index.html`; Create `src/core/parallel.ts`; tests `tests/parallel.test.ts`, `tests/session.test.ts`.

**Interfaces – Produces:**
- Config `turn.parallel_dev: number` (1–3, mặc định 1). Kiểm config: > 1 cần ≥ `parallel_dev` agent có `dev` trong `can_sit`.
- `src/core/parallel.ts`:
  - `readyTickets(tickets: Ticket[], states: Map<string, TicketState>, max: number): Ticket[]` – ticket `pending`/`returned` có mọi `depends_on` đã `passed`, sắp theo `number`, lấy tối đa `max`.
  - `pickDevs(cfg, store, n, busy: Set<string>, usable): string[]` – ghế dev trước, rồi agent `can_sit` dev khác theo thứ tự config, bỏ agent đang bận và agent không còn tài khoản dùng được.
  - `ticketBranch(id: string): string` = `ticket/<ID>`.
  - `mergeTicket(repo, goalBranch, id): { ok: true; sha: string } | { ok: false; reason: 'merge_conflict' }` – `merge --no-ff` với tác giả `core`; conflict → `merge --abort`, trả lỗi.
- `processGoal`: khi `parallel_dev > 1`, mỗi ticket sẵn sàng chạy Dev trên `ticket/<ID>` tách từ đỉnh nhánh goal, trong workspace riêng của agent được chọn (đã có: `/srv/btm-work/btm-<agent>/<project>`). Các bước đụng checkout tin cậy (`syncWorkspace`, `importTurn`, gate, commit) chạy **tuần tự** dưới một khoá trong process (`withRepoLock`). QC pass → `mergeTicket`; conflict → ticket `returned`, ghi chú `merge_conflict`, Dev làm lại từ đỉnh mới.
- Luật QC giữ nguyên: QC của ticket ≠ agent đã code ticket đó (đã có, theo `ticket_history`). Nếu không có QC hợp lệ → `needs_owner` như cũ.
- Dashboard: thẻ ghế Dev hiện nhiều dòng "đang làm" (agent · ticket · đồng hồ) khi song song.

- [ ] **Bước 1: Test fail `tests/parallel.test.ts`:** `readyTickets` bỏ ticket còn phụ thuộc chưa pass; `pickDevs` không chọn agent bận / hết tài khoản; `mergeTicket` 2 ticket sửa file khác nhau → cả hai ok; cùng dòng của một file → ticket sau `merge_conflict`, nhánh goal không đổi.
- [ ] **Bước 2: Test fail `session.test.ts`:** `parallel_dev: 2`, 2 ticket độc lập, runner giả có deferred → hai lượt Dev **chồng thời gian** (lượt 2 bắt đầu trước khi lượt 1 xong), cả hai pass, nhánh goal chứa cả hai merge; ticket thứ 3 phụ thuộc ticket 1 chỉ bắt đầu sau khi ticket 1 pass; `parallel_dev: 1` → thứ tự lượt y như cũ (test case 1 hiện có không đổi).
- [ ] **Bước 3:** Code. Trước khi sửa `processGoal`, đọc hết đoạn Dev → gate → QC (khoảng dòng 700–1560) và liệt kê mọi chỗ dùng `d.repo` HEAD; mỗi chỗ phải nằm trong `withRepoLock` hoặc dùng ref nhánh ticket rõ ràng.
- [ ] **Bước 4:** Test xanh, full suite, `tsc`. Review độc lập riêng cho task này (nhiều rủi ro nhất). Commit, VM ×3, merge. Bật trên VM chỉ khi anh đồng ý.

## Thứ tự và phụ thuộc
1 → 2 → 3 → 4. Task 1 sửa lỗ hổng nên làm ngay. Task 3 cần vòng GameTest-BTM G1 đã push thành công một lần (để thử CI thật). Task 4 làm cuối, sau khi G1 chạy trọn vòng.

## Ngoài phạm vi
- Comment review trên PR (cần PR → cần token GitHub; chờ decision mới).
- Đọc log CI chi tiết (API log cần xác thực).
- Agent LLM tự điều phối, bypass quyền, telemetry, cloud workspace (xem research "Không lấy").
