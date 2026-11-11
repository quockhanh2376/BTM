# BTM – Kế hoạch 5: Đội hình linh hoạt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy ở dự án này:** Cheki giao Victor (Antigravity) qua `team/bin/agy-run.sh` + `team/board.md`, Qeen review read-only; Cheki kiểm diff, test trên VM Ubuntu, commit, push, ghi `team/log.md`. Nhánh `plan5-flexible-team` tạo từ `main` sau Plan 4.5 (cách ly đang chạy trên VM).

**Goal:** Mọi ghế (PM, Dev, QC, Audit) gắn được với bất kỳ agent nào, một agent kiêm nhiều ghế, mỗi agent chọn model và tài khoản riêng (vd thêm 1 tài khoản Antigravity/Gemini làm Kai, Codex làm Kai, Claude kiêm PM + Audit), và mỗi project có đội hình riêng.

**Architecture (cập nhật 2026-11-10 sau Plan 4.5):** Agent = công cụ + model + effort + **user Linux riêng** `btm-<id>`. Tài khoản tách sẵn nhờ home riêng của user đó (wrapper `btm-worker-exec` xoá sạch env), nên **bỏ `account_env`** của bản cũ. Thêm agent mới = thêm vào `btm.config.yaml` + chạy `BTM_AGENTS="… kai" isolation-setup.sh prep` + đăng nhập CLI dưới `btm-kai`. Energy/đăng nhập đã đọc theo user riêng (P4.5). Đội hình: `btm.config.yaml` (mặc định) ← `team/project.yaml` `seats:` (theo project) ← đổi ghế trên dashboard (lưu theo project). Một hàm duy nhất `effectiveSeats(cfg, store, project)` quyết định ai ngồi ghế nào.

**Tech Stack:** như Kế hoạch 1–4.

**Spec:** yêu cầu anh Zon 2026-11-09 (team/log.md) + `docs/spec.md` §3, §8, §10 + `docs/tickets.md` §5.

**Đã kiểm tra trước:** Gemini CLI đã ngừng (06/2026) – Gemini chạy qua `agy --model gemini-…`. Trên VM (2026-11-10): `btm-elon` (Claude), `btm-jacky` (agy), `btm-jenny` (Codex) đã đăng nhập; `agy models` dưới `btm-jacky` liệt kê được model.

**Model + mức suy luận (anh Zon 2026-11-10):** chọn **theo agent** (không theo ghế). Mặc định: model mặc định của từng CLI (không truyền cờ model) + effort **medium**. Anh chọn tay trên dashboard (Task 5): ô model (danh sách thật của CLI: `agy models`, model Codex của tài khoản, danh sách Claude cố định theo bản cài) + ô effort (low/medium/high/xhigh/max; Codex chỉ low/medium/high). Lưu theo agent, áp từ lượt kế; đang có lượt chạy → 409. Model bị CLI từ chối → lượt lỗi, thẻ báo rõ, không tự đổi model.

## Global Constraints

- Vẫn **không API key**; `login.forbidden_env` giữ nguyên. Agent chạy dưới `btm-<id>` qua wrapper (env sạch) – không thêm đường truyền env nào vào wrapper.
- Không bao giờ đọc/in/lưu nội dung credential trong home của agent (như Kế hoạch 3).
- Chế độ không cách ly (Windows/dev): mọi agent dùng tài khoản của user đang chạy BTM, như hiện nay.
- `rules.auto_switch_accounts: false` giữ nguyên (không xoay vòng tài khoản của CÙNG một agent). Thay **agent** khi hết Energy theo danh sách dự phòng là Task 7 (anh Zon 2026-11-10); hết cả → Dừng.
- Luật cứng giữ nguyên với đội hình mới: coder ≠ QC của ticket đó; coder ≠ audit của goal; một agent được kiêm nhiều ghế còn lại (vd PM + Audit, PM + QC).
- Đổi đội hình khi đang có phiên/lượt chạy → từ chối (409), như Kế hoạch 3.
- Test không gọi CLI thật; `npx vitest run` không tăng fail; `npx tsc --noEmit` sạch.

## Review Focus

1. **Một agent kiêm Dev + QC** (vd cùng là `qeen`) → luật coder ≠ QC vẫn chặn khi QC đúng ticket mình code, phiên `needs_owner` rõ lý do, không tự pass. (Task 4)
2. **Model/effort lạ** (ký tự shell, effort Codex `max`) → model bị chặn khi load/khi lưu từ dashboard; effort Codex quy về `high`. (Task 1, Task 2)
3. **Hai agent cùng công cụ** (vd `kai` và `jacky` đều là agy, khác user) → Energy/đèn đăng nhập riêng, hết hạn mức của `kai` không chặn `jacky`; agent có trong config nhưng chưa có user Linux → đèn `relogin` với lệnh tạo user, không crash. (Task 3)
4. **`team/project.yaml` ghi ghế cho agent không tồn tại / không có ghế trong `can_sit`** → bỏ qua override đó, dùng mặc định, dashboard hiện cảnh báo – không crash. (Task 4)
5. **Đổi ghế trên dashboard ở project A** → project B không bị đổi. (Task 4, Task 5)

---

## File Structure

- Modify `src/config.ts` – `agents.<id>.model`, `agents.<id>.effort`.
- Modify `src/runner/argv.ts`, `src/runner/run.ts` – cờ model + effort theo công cụ.
- Modify `src/energy/login.ts`, `src/energy/monitor.ts` – agent chưa có user Linux.
- Modify `src/store/db.ts` (`effectiveSeats` + khoá setting theo project), `src/ticket/goal.ts` (`readProjectSeats`), `src/core/session.ts`, `src/server/host.ts`, `src/server/http.ts`, `src/server/snapshot.ts` – mọi chỗ gọi `effectiveSeats` truyền `project`.
- Modify `web/index.html` – đổi ghế theo project (cả Audit), chọn model/effort theo agent, mục Tài khoản.
- Modify `deploy/isolation-setup.sh` (dọn cấu hình CLI mỗi lượt – Task 8), `btm.config.yaml`, `docs/spec.md` §3; Create `docs/team-setup.md`.

---

### Task 1: Agent có model + effort (config)

**Files:** Modify `src/config.ts`; tests `tests/config.test.ts`.

**Interfaces – Produces:** `AgentConfigSchema` thêm `model?: string` (`/^[A-Za-z0-9._:-]{1,80}$/`), `effort?: 'low'|'medium'|'high'|'xhigh'|'max'` (mặc định `medium`). Agent id phải hợp tên user Linux khi bật cách ly (`/^[a-z_][a-z0-9_-]{0,15}$/`) → lỗi khi load.

- [ ] **Step 1: Test:** `kai: {tool: antigravity-cli, model: gemini-3.8-flash-high, can_sit: [audit]}` load ok, effort mặc định `medium`; model `a;rm` → lỗi; effort `ultra` → lỗi; có `worker_prefix` + agent id `Kai!` → lỗi.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: per-agent model and effort (P5 Task 1)`.

### Task 2: Runner chạy đúng model + effort

**Files:** Modify `src/runner/argv.ts`, `src/runner/run.ts`; tests `tests/argv.test.ts`, `tests/run.test.ts`.

**Interfaces – Consumes:** Task 1. **Produces:** `ArgvOpts` thêm `model?: string`, `effort: Effort`; `agentModel(cfg, store, id)` / `agentEffort(cfg, store, id)` – setting dashboard `agent_model:<id>` / `agent_effort:<id>` ghi đè config.
- claude-code: `--model <m>` + `--effort <e>`; codex-cli: `-m <m>` + `-c model_reasoning_effort="<e>"` (xhigh/max → high); antigravity-cli: `--model <m>` + `--effort <e>` trong chuỗi lệnh agy (giữ quoting hiện có). Không có model → không thêm cờ model. Effort luôn truyền.
- Áp cho mọi lượt (pm/dev/qc/audit + lệnh trực tiếp dashboard).

- [ ] **Step 1: Test:** argv có/không `--model` theo từng công cụ; effort Codex `max` → `high`; setting dashboard ghi đè config; model setting không hợp lệ → bỏ qua, dùng config.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: runner uses agent model and effort (P5 Task 2)`.

### Task 3: Agent mới chưa có user Linux

**Files:** Modify `src/energy/login.ts`, `src/energy/monitor.ts`; tests `tests/login.test.ts`, `tests/monitor.test.ts`.

- Energy + đăng nhập đã chạy dưới `btm-<id>` (P4.5). Bổ sung: sudo báo không có user / không được phép → trạng thái `relogin`, ghi chú "Chưa có user btm-<id> – chạy isolation-setup.sh prep với BTM_AGENTS" + lệnh đăng nhập đúng user. Gate Energy chặn agent đó, không chặn agent khác.

- [ ] **Step 1: Test** (runner giả): output sudo "unknown user" → `relogin` với ghi chú đúng; agent khác vẫn `ok`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: missing worker user shows relogin with setup hint (P5 Task 3)`.

### Task 4: Đội hình theo project

**Files:** Modify `src/store/db.ts`, `src/ticket/goal.ts`, `src/core/session.ts`, `src/server/host.ts`, `src/server/http.ts`, `src/server/snapshot.ts`; tests `tests/store.test.ts`, `tests/goal.test.ts`, `tests/session.test.ts`, `tests/host.test.ts`.

**Interfaces – Produces:**
- `readProjectSeats(repo): Partial<Record<Seat, string>>` – đọc `seats:` trong `team/project.yaml` (thiếu → `{}`; sai định dạng → `{}` + cảnh báo).
- `effectiveSeats(cfg, store, project?: string | null): Record<Seat, string>` – thứ tự: dashboard override theo project (setting `seat:<project>:<seat>`) > `team/project.yaml` > `cfg.seats`; áp dụng cho **cả 4 ghế** (hiện tại bỏ sót `audit`); override không hợp lệ (agent lạ / thiếu `can_sit`) → bỏ qua + ghi cảnh báo vào snapshot.
- Mọi chỗ gọi `effectiveSeats` truyền project active. Đổi ghế qua `POST /api/seat` lưu theo project active.
- Setting cũ `seat:<seat>` (không có project) vẫn được đọc như mặc định chung để không mất cấu hình đang chạy.

- [ ] **Step 1: Test:** project A `seats: {pm: elon, audit: elon}` → PM và Audit đều là `elon`, project B vẫn dùng mặc định; đổi ghế ở A không đổi B; `qeen` ngồi cả Dev và QC → QC ticket do `qeen` code bị `coder_cannot_qc_same_task`; `elon` kiêm PM + Audit → audit vẫn chạy (PM không code); `team/project.yaml` ghi `audit: ghost` → bỏ qua, có cảnh báo; override `audit` trên dashboard có hiệu lực.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: per-project seats for all four seats (P5 Task 4)`.

### Task 5: Dashboard – đổi ghế theo project, mục Tài khoản

**Files:** Modify `web/index.html`, `src/server/snapshot.ts`; tests `tests/web.test.ts`, `tests/snapshot.test.ts`.

- Thẻ ghế (cả Kai-Audit khi có ghế audit): ô "Người ngồi ghế" liệt kê agent có `can_sit` chứa ghế đó; dưới tên công cụ hiện model (nếu có). Agent kiêm nhiều ghế hiện nhãn nhỏ "kiêm PM" / "kiêm Audit".
- Mục Tài khoản: mỗi agent 1 dòng – công cụ, user Linux (`btm-<id>`), ô chọn model (danh sách thật của CLI khi đọc được, không thì ô nhập) + ô effort (Codex chỉ low/medium/high), đèn đăng nhập, lệnh đăng nhập để sao chép (vd `ssh -t … "sudo -iu btm-jenny codex login --device-auth"`). Lưu model/effort qua `POST /api/agent` (`x-btm: 1`), áp từ lượt kế; đang có lượt chạy → 409.
- Cảnh báo từ Task 4 (override bị bỏ qua) hiện trên thanh phiên.
- Giữ a11y, tương phản ≥ 4.5:1, `.seat-footer { margin-top: auto; }`.

- [ ] **Step 1: Test:** snapshot có model/effort/user/nhãn kiêm nhiệm đúng; web có select cho ghế audit; lệnh đăng nhập chứa đúng `sudo -iu btm-<id>`; `POST /api/agent` model lạ → 400, khi đang chạy → 409; nội dung chèn bằng `textContent`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Cheki mở dashboard demo đo/chụp (như P4-T9).
- [ ] **Step 6:** Commit `feat: dashboard seats per project, accounts with model (P5 Task 5)`.

### Task 6: Cấu hình mẫu + tài liệu

**Files:** Modify `btm.config.yaml`, `docs/spec.md` §3; Create `docs/team-setup.md`.

- `btm.config.yaml`: thêm ví dụ (comment) – `kai` agy + Gemini; Claude kiêm PM + Audit qua `team/project.yaml`; `seats_backup`.
- `docs/team-setup.md` (≤ 1 trang): thêm agent mới (config → `BTM_AGENTS=… isolation-setup.sh prep` → đăng nhập dưới `btm-<id>`), gắn agent vào ghế, đội hình theo project, luật kiêm nhiệm được/không được.
- [ ] **Step 1:** `loadConfig(btm.config.yaml)` vẫn hợp lệ (test có sẵn). **Step 2:** Commit `docs: flexible team setup (P5 Task 6)`.

### Task 7: Thay ghế khi hết Energy, hết cả thì Dừng

**Yêu cầu anh Zon (2026-11-10):** agent ngồi ghế hết hạn mức → agent khác (Codex, Grok, …) ngồi thay; tất cả đều hết → Dừng.

**Files:** Modify `src/config.ts`, `src/store/db.ts`, `src/core/session.ts`, `src/server/snapshot.ts`, `web/index.html`; tests `tests/config.test.ts`, `tests/session.test.ts`, `tests/web.test.ts`.

**Interfaces – Consumes:** Task 3 (Energy theo agent), Task 4 (`effectiveSeats`). **Produces:**
- Config `seats_backup: { <seat>: [agentId, …] }` (mặc định `{}`; theo project ghi đè được trong `team/project.yaml` `seats_backup:`); mỗi id phải có ghế trong `can_sit`.
- `pickSeatAgent(cfg, store, project, seat, energy): { agent: string; substitute: boolean } | null` – người chính còn Energy → người chính; không thì người đầu tiên trong `seats_backup` còn Energy, đăng nhập ok và **không vi phạm luật cứng** (coder ≠ QC ticket, coder ≠ audit goal); không ai → `null`.
- Lượt bị lỗi hạn mức (vd agy `RESOURCE_EXHAUSTED`/"quota reached", codex/claude báo hết usage) → đánh dấu agent hết Energy tới giờ hồi, chạy lại lượt đó với người thay (không tính thêm 1 vòng sửa).
- `null` → phiên **Dừng** (như nút Dừng: khoá phiên, không xoá việc dở), `needs_owner` note `all_agents_exhausted` kèm giờ hồi sớm nhất.
- Mỗi lần thay ghi turn note `seat_substitute:<seat>:<from>-><to>`; dashboard hiện nhãn "thay <tên>" trên thẻ ghế.

- [ ] **Step 1: Test:** Dev chính hết Energy, backup codex còn → lượt dev chạy bằng codex, note thay ghế; lỗi quota giữa lượt → chạy lại bằng backup; backup là coder của ticket → không được ngồi QC, thử người kế; mọi người hết → phiên dừng `all_agents_exhausted`, không chạy thêm lượt; người chính hồi Energy → lượt sau quay về người chính.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: seat failover when energy runs out, stop when all exhausted (P5 Task 7)`.

**Trạng thái Task 7 (Cheki 2026-11-10):**
- Đã làm: thay ghế trước lượt theo Energy và đăng nhập, áp luật cứng cho cả người ngồi thay; hết cả thì `needs_owner` với `all_agents_exhausted` kèm lý do từng người; dashboard có nhãn "ngồi thay".
- Chưa làm:
  - lỗi hạn mức giữa lượt chưa tự chạy lại (lượt báo lỗi, anh bấm Tiếp tục thì BTM chọn lại người);
  - `seats_backup` theo project;
  - dừng/khoá phiên như nút Dừng;
  - giờ hồi sớm nhất.

### Task 8: Dọn cấu hình CLI của agent trước mỗi lượt (review P45 M1)

Cùng một agent đổi ghế (vd jenny Dev ticket A → QC ticket B) không được mang theo cấu hình mình tự sửa lúc làm Dev.

**Files:** Modify `deploy/isolation-setup.sh` (wrapper mới `btm-worker-reset`, sudoers), `src/isolation/worker.ts`, `src/runner/run.ts`; tests `tests/worker.test.ts`, `tests/run.test.ts`.

- `btm-worker-reset` (chạy dưới `btm-<id>`): xoá `~/.gitconfig`, `~/.npmrc`, `~/.config/git`, file hướng dẫn agent ở home (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) và hook/settings người dùng của CLI; **giữ nguyên** file đăng nhập (danh sách giữ lại cố định trong script, Bước 0 xác định tên file, không đọc nội dung).
- Runner gọi reset sau killall đầu lượt, trước sync. Reset lỗi → lượt `sync_failed`.

- [ ] **Step 0:** liệt kê tên file trong home 3 user trên VM (không đọc nội dung) → chốt danh sách giữ/xoá.
- [ ] **Step 1: Test:** thứ tự runner `kill → reset → sync → run → kill → import → kill`; wrapper reset trên VM xoá `~/.gitconfig` agent tạo, đăng nhập vẫn còn (`claude auth status` ok).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: reset agent CLI config before each turn (P5 Task 8)`.

---

## Để sau

Thêm/sửa agent ngay trên dashboard (hiện sửa `btm.config.yaml`); nhiều agent chạy song song (v2.0). Giao diện song ngữ Anh/Việt (nút EN/VI, nhớ lựa chọn trên trình duyệt) – anh Zon 2026-11-10, làm ở plan sau; từ giờ chuỗi giao diện mới gom về một chỗ để dễ dịch.

Sao lưu/khôi phục tài khoản Antigravity (anh Zon 2026-11-10, làm khi app ổn định):
- Script `deploy/agy-accounts.sh`, gồm các lệnh:
  - `export`: ghi file JSON trần `[{email, refresh_token}]`, giống mẫu anh đang lưu;
  - `import <file>`;
  - `use <email>`;
  - `list`: chỉ in email.
- Ghi đăng nhập vào home của `btm-jacky` với quyền 600, rồi chạy `agy models` để kiểm.
- Bước 0: tìm chỗ agy lưu đăng nhập (chỉ xem tên khoá, không in giá trị) và xác nhận chỉ cần refresh token là đủ.
- Không in token, không đưa token vào tham số dòng lệnh.
- `.gitignore` chặn `*accounts*.json*`; quét bí mật trước khi push bắt cả `"refresh_token"`.
- Sau đó nối vào luật thay ghế: hết hạn mức thì chuyển sang tài khoản agy kế tiếp, hết cả thì chuyển sang agent khác.
