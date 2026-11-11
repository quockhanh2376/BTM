# BTM – Kế hoạch 6: Ý tưởng từ Orca Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy:** Cheki code từng task trên nhánh riêng (`plan6-<task>`), test VM ×3, review độc lập cuối mỗi gói, rồi tự merge (luật 2026-11-11). Deploy/restart VM hỏi anh Zon. **Làm từ từ**: mỗi task là một PR, không cần làm liền một lượt; thứ tự gợi ý ở cuối.

**Goal:** Đưa 7 ý tưởng từ Orca vào BTM: báo cho anh khi cần, tự chạy lại lượt khi agent hết hạn mức giữa chừng, review diff có ghi chú từng dòng, câu hỏi chặn ticket, cảnh báo Energy, phát hiện lượt treo, dòng trạng thái do agent tự viết.

**Architecture:** Mọi tính năng gắn vào chỗ có sẵn: thông báo ở host (sau mỗi kết quả phiên), lỗi hạn mức ở runner + `pickSeatAgent` (Plan 5), diff/ghi chú/câu hỏi ở store + `/api/*` + dashboard, lượt treo ở `runProcess`, trạng thái qua worker như `readWorkerOut`. Không đổi mô hình cách ly user Linux.

**Tech Stack:** như Kế hoạch 1–5.

**Spec:** `docs/research/2026-11-11-orca.md` (mục "Nên lấy" 1–7) + yêu cầu anh Zon 2026-11-11.

## Global Constraints

- Vẫn **không API key cho agent**. Token gửi thông báo (nếu dùng Telegram) là bí mật của **BTM**, không của agent: nằm ngoài git, đọc từ file `0600` của user `agent` (systemd `LoadCredential`), không bao giờ vào env của worker, log, dashboard hay `team/runs`. Cần anh chốt kênh (Task 1, Bước 0).
- Không đọc/in nội dung credential của CLI (như Kế hoạch 3).
- Luật cứng giữ nguyên: người code ≠ QC ticket, ≠ Audit goal; agent không đổi được ghế; mọi thứ agent viết ra là dữ liệu không tin cậy (hiển thị bằng `textContent`, giới hạn kích thước).
- Mọi API mới: `x-btm: 1`, `127.0.0.1`, đang có lượt chạy → 409 nếu thay đổi trạng thái.
- Test không gọi CLI thật/mạng thật; `npx vitest run` không tăng fail; `npx tsc --noEmit` sạch; VM ×3.

## Review Focus

1. **Thông báo lộ bí mật hoặc nội dung agent điều khiển** (agent viết `@everyone`/link lạ vào báo cáo) → tin nhắn chỉ chứa mẫu cố định + mã lý do + link dashboard, không chép văn bản tự do của agent. (Task 1)
2. **Nhận nhầm lỗi hạn mức** (agent in chuỗi "usage limit reached" trong code/test của nó) → chỉ tin khi lượt **thất bại** (exit ≠ 0) và chuỗi nằm ở dòng lỗi cuối của CLI, không phải bất kỳ đâu trong output; chạy lại tối đa 1 lần/lượt. (Task 2)
3. **Diff khổng lồ / file nhị phân / tên file có ký tự lạ** → API cắt ở giới hạn, đánh dấu "đã cắt", dashboard không treo. (Task 3)
4. **Câu hỏi của agent chứa HTML/markdown độc** → hiển thị bằng `textContent`; câu trả lời của anh vào prompt lượt sau trong khối trích dẫn có nhãn. (Task 4)
5. **Ngưỡng treo giết nhầm CLI im lặng hợp lệ** (Claude `-p` chỉ in khi xong) → phát hiện treo chỉ bật cho công cụ có in tiến độ; mặc định tắt. (Task 6)

---

### Task 1: Báo cho anh khi cần (ntfy hoặc Telegram)

**Files:** Create `src/notify/notify.ts`; Modify `src/config.ts`, `src/server/host.ts`; tests `tests/notify.test.ts`, `tests/host.test.ts`.

**Interfaces – Produces:**
- Config `notify?: { kind: 'ntfy' | 'telegram'; url?: string; chat_id?: string; credential_file?: string; dashboard_url?: string; on: Array<'needs_owner' | 'awaiting_approval' | 'goal_done' | 'energy_out'> }`.
- `notify(cfg, event: { kind: NotifyKind; reason: string; project: string; goal?: string }, send = fetch): Promise<void>` – không ném lỗi (lỗi gửi chỉ ghi log), timeout 10 s, không gửi lại cùng sự kiện trong 10 phút.
- Host gọi `notify` sau mỗi kết quả phiên (`needs_owner`, `awaiting_approval`, `done`) và khi `all_agents_exhausted`.

- [ ] **Step 0:** Anh chọn kênh: ntfy (topic riêng, không cần token nếu topic khó đoán; hoặc ntfy tự host) hay Telegram (bot token → `credential_file`). Ghi vào decision 0003-notify.
- [ ] **Step 1: Test:** tin nhắn đúng mẫu `[BTM] <project> · <lý do> · <link>`; lý do là mã cố định (`needs_owner:coder_cannot_qc_same_task`), không chứa văn bản tự do của agent; lỗi mạng không làm hỏng phiên; trùng sự kiện trong 10 phút → gửi 1 lần; không có `notify` → không gọi gì; token không xuất hiện trong log.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** gửi thử thật 1 tin từ VM (anh xác nhận nhận được).
- [ ] **Step 6:** Commit `feat: notify owner on needs_owner/approval/exhausted (P6 Task 1)`.

### Task 2: Hết hạn mức giữa lượt → chạy lại bằng người dự phòng

Lấp phần thiếu của Plan 5 Task 7.

**Files:** Create `src/agents/usage-limit.ts`; Modify `src/runner/run.ts`, `src/core/session.ts`, `src/store/db.ts`; tests `tests/usage-limit.test.ts`, `tests/session.test.ts`.

**Interfaces – Produces:**
- `detectUsageLimit(tool: Tool, r: ProcResult, now: Date): { resetsAt: string | null } | null` – chỉ khi `exitCode !== 0`, xét **phần đuôi** output (2 KB cuối): Claude "usage limit reached … resets <giờ>"/"5-hour limit", Codex "You've hit your usage limit"/`usage_limit_reached`, agy `RESOURCE_EXHAUSTED`/"quota". Giờ hồi đọc được → ISO; không → `null`.
- `TurnOutput.usageLimit?: { resetsAt: string | null }`.
- Store: ghi một bản Energy `{status:'fresh', windows:[{name:'limit', remainingPercent:0, resetsAt}]}` (không có giờ → +1 giờ) để gate chặn agent đó tới giờ hồi.
- Session: mỗi chỗ chạy lượt (pm/dev/qc/audit) – nếu `usageLimit` → kết thúc lượt `usage_limited` (không tính vòng sửa, không ghi lỗi coder), chạy `pickSeatAgent` lại (loại agent vừa hết) và chạy lại lượt **một lần**; không ai → `all_agents_exhausted` kèm giờ hồi sớm nhất. Turn note `seat_substitute:<seat>:<from>-><to>`.
- Tiện thể sửa 2 điểm còn thiếu của P5-T7: `seats_backup` theo project (`team/project.yaml` trên main) và note giờ hồi sớm nhất.

- [ ] **Step 0:** Lấy mẫu chữ lỗi hạn mức thật của 3 CLI (từ log cũ trong `team/runs`/log VM, không chạy cố cho hết hạn mức) → fixture.
- [ ] **Step 1: Test:** fixture từng CLI → nhận đúng + giờ hồi; output thành công chứa chuỗi đó → không nhận; chuỗi nằm giữa output (không ở đuôi) → không nhận; Dev hết giữa lượt → lượt chạy lại bằng jenny, vòng sửa không tăng, note thay ghế; người chạy lại cũng hết → dừng `all_agents_exhausted` + giờ hồi; QC hết giữa lượt → người thay không phải coder.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: rerun turn with backup on mid-turn usage limit (P6 Task 2)`.

### Task 3: Xem diff ticket và ghi chú từng dòng

**Files:** Create `src/server/diff.ts`; Modify `src/store/db.ts` (bảng `line_notes`), `src/server/http.ts`, `src/core/session.ts`, `web/index.html`; tests `tests/diff.test.ts`, `tests/http.test.ts`, `tests/session.test.ts`, `tests/web.test.ts`.

**Interfaces – Produces:**
- `GET /api/ticket/:id/diff` → `{ files: [{ path, hunks: [{ header, lines: [{ kind: '+'|'-'|' ', text, newLine?: number }] }] }], truncated: boolean }` – `git diff --no-ext-diff --no-color base..goal-branch` trong checkout tin cậy, tối đa 400 KB / 2 000 dòng, file nhị phân chỉ ghi tên.
- `POST /api/ticket/:id/notes` `{ path, line, text ≤ 1000 }` → lưu; `POST /api/ticket/:id/return` → ticket `returned` với ghi chú thành `fixNotes` dạng `<path>:<line> – <text>` cho lượt Dev kế; 409 khi đang chạy.
- Dashboard: nút "Xem diff" trên ticket ở thẻ goal → khung diff (đơn giản, monospace), bấm số dòng để ghi chú, nút "Trả về Dev".

- [ ] **Step 1: Test:** diff đúng file/hunk/số dòng; diff lớn → `truncated`; tên file có dấu cách/Unicode; ghi chú vào `fixNotes` của lượt Dev sau; ticket không tồn tại → 404; text ghi chú > 1000 → 400; web dùng `textContent`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Cheki mở dashboard demo chụp.
- [ ] **Step 6:** Commit `feat: ticket diff view with line notes back to dev (P6 Task 3)`.

### Task 4: Câu hỏi chặn ticket (decision gate)

**Files:** Modify `src/store/db.ts` (bảng `questions`), `src/core/session.ts`, `src/server/http.ts`, `src/server/snapshot.ts`, `src/core/prompts.ts` (nơi dựng prompt), `web/index.html`; tests tương ứng.

**Interfaces – Produces:**
- Từ báo cáo Dev/QC: mỗi dòng `Cần xác nhận: …` (đã có trong schema báo cáo) → 1 câu hỏi `{ id, ticket, seat, agent, text ≤ 500, answer?, state: 'open'|'answered' }`.
- Ticket có câu hỏi mở → state `blocked`; phiên **chạy tiếp ticket khác** của goal; hết ticket chạy được → `needs_owner` với note `questions_open:<n>` (Task 1 báo cho anh).
- `POST /api/question/:id/answer { text ≤ 2000 }` → `answered`; "Tiếp tục" → ticket chạy lại với khối "Anh Zon trả lời: …" trong prompt.
- Dashboard: mục "Câu hỏi" liệt kê câu hỏi mở + ô trả lời.

- [ ] **Step 1: Test:** báo cáo có 2 dòng "Cần xác nhận" → 2 câu hỏi, ticket `blocked`, ticket khác vẫn chạy; trả lời xong → prompt lượt sau chứa câu trả lời; câu hỏi chứa `<script>` hiển thị nguyên văn; agent không tự trả lời được (API cần `x-btm`, agent không có đường mạng tới dashboard – ghi chú).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: agent questions block a ticket, owner answers on dashboard (P6 Task 4)`.

### Task 5: Cảnh báo Energy thấp, tài khoản xếp theo giờ hồi

**Files:** Modify `src/server/snapshot.ts`, `web/index.html`; tests `tests/snapshot.test.ts`, `tests/web.test.ts`.

- Snapshot thêm `energyWarn: boolean` (cửa sổ thấp nhất ≤ `energy.warn_percent`, mặc định 20) và `soonestReset` cho seat/account.
- Dashboard: chip "Sắp hết · hồi HH:mm" (tương phản ≥ 4.5:1, không chỉ dùng màu); mục Tài khoản xếp agent có giới hạn chặt nhất trước.

- [ ] **Step 1: Test:** 15% → `energyWarn`, 25% → không; sắp xếp theo `soonestReset`; chip có chữ, không chỉ màu.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: low-energy warning chip, accounts sorted by soonest reset (P6 Task 5)`.

### Task 6: Phát hiện lượt treo (không ra output N phút)

**Files:** Modify `src/config.ts` (`turn.idle_minutes?: Partial<Record<Tool, number>>`), `src/runner/run.ts` (`runProcess` option `idleTimeoutMs`), `src/core/session.ts` (lý do `idle_timeout`); tests `tests/run.test.ts`, `tests/config.test.ts`.

- `runProcess`: không có byte stdout/stderr nào trong `idleTimeoutMs` → giết như timeout (kể cả `onKill` cho worker), `ProcResult.idleTimedOut = true`.
- Chỉ áp cho công cụ có in tiến độ (agy, codex); **claude mặc định tắt** vì `-p` chỉ in khi xong (muốn bật phải chuyển sang `--output-format stream-json` – để sau).
- Lượt treo → kết thúc `idle_timeout`, xử lý như timeout hiện có.

- [ ] **Step 0:** Đo trên VM khoảng im lặng dài nhất bình thường của agy và codex trong log cũ → chọn mặc định (vd 10 phút).
- [ ] **Step 1: Test:** tiến trình im 200 ms với ngưỡng 100 ms → bị giết, `idleTimedOut`; tiến trình in đều → không bị giết; claude không có ngưỡng → không áp.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: idle-output watchdog per tool (P6 Task 6)`.

### Task 7: Dòng trạng thái do agent tự viết

**Files:** Modify `src/isolation/trusted.ts` (`readWorkerStatus`), `src/server/snapshot.ts`, `src/core/prompts.ts`, `web/index.html`, `deploy/isolation-setup.sh` (xoá file trạng thái ở reset); tests tương ứng.

- Prompt mọi ghế thêm 1 dòng: "Khi xong một bước, ghi 1 dòng ngắn việc đang làm vào file `../.btm-status`" (thư mục riêng của worker, ngoài workspace nên không bị commit).
- Snapshot đọc qua worker (`test -f && head -c 200`, timeout 5 s, cache 15 s) khi ghế đang chạy; không cách ly → đọc file cạnh log.
- Thẻ ghế: hiện dòng trạng thái (cắt 200 ký tự, `textContent`); không có → dòng log cuối như cũ.

- [ ] **Step 1: Test:** có file → hiện đúng, cắt 200; FIFO/symlink → bỏ qua; ghế không chạy → không đọc; reset xoá file cũ.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: agent-written status line on seat cards (P6 Task 7)`.

---

## Thứ tự gợi ý

1. Task 1 (báo cho anh), sau khi anh chốt kênh. Task 5 (cảnh báo Energy) làm kèm vì nhỏ.
2. Task 2 (hết hạn mức giữa lượt).
3. Task 6 (lượt treo) và Task 7 (dòng trạng thái).
4. Task 3 (diff + ghi chú) rồi Task 4 (câu hỏi chặn ticket). Hai task này cùng đụng tới luồng ticket và dashboard, nên làm sau cùng.

## Để sau

- Claude chuyển sang `--output-format stream-json`, để có tiến độ (bật được Task 6 cho Claude) và lý do dừng có cấu trúc.
- Điều khiển agent bằng ACP.
- Lịch tự động.
- Chạy song song.
- Kho nhiều tài khoản agy.

(Xem `docs/research/2026-11-11-orca.md`.)
