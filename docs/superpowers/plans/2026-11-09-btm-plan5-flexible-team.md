# BTM – Kế hoạch 5: Đội hình linh hoạt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy ở dự án này:** Cheki giao Victor (Antigravity) qua `team/bin/agy-run.sh` + `team/board.md`, Qeen review read-only; Cheki kiểm diff, test trên VM Ubuntu, commit, push, ghi `team/log.md`. Nhánh `plan5-flexible-team` tạo từ `main` **sau khi Plan 4 merge**.

**Goal:** Mọi ghế (PM, Dev, QC, Audit) gắn được với bất kỳ agent nào, một agent kiêm nhiều ghế, mỗi agent chọn model và tài khoản riêng (vd thêm 1 tài khoản Antigravity/Gemini làm Kai, Codex làm Kai, Claude kiêm PM + Audit), và mỗi project có đội hình riêng.

**Architecture:** Agent = công cụ + model + tài khoản. Tài khoản tách bằng biến môi trường riêng của từng CLI (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGY_ACCOUNT`/`ANTIGRAVITY_GEMINI_DIR`) – Runner, đọc Energy và đèn đăng nhập đều chạy với env của agent đó. Đội hình: `btm.config.yaml` (mặc định) ← `team/project.yaml` `seats:` (theo project) ← đổi ghế trên dashboard (lưu theo project). Một hàm duy nhất `effectiveSeats(cfg, store, project)` quyết định ai ngồi ghế nào.

**Tech Stack:** như Kế hoạch 1–4.

**Spec:** yêu cầu anh Zon 2026-11-09 (team/log.md) + `docs/spec.md` §3, §8, §10 + `docs/tickets.md` §5.

**Đã kiểm tra trước (2026-11-09):** `agy` hỗ trợ nhiều tài khoản đăng nhập cùng lúc, chọn bằng `AGY_ACCOUNT=<email>` (sai → lỗi "matches no signed-in account"); thư mục cấu hình riêng `ANTIGRAVITY_GEMINI_DIR`. Gemini CLI đã ngừng (06/2026) – Gemini chạy qua `agy --model gemini-…` (`agy models` có `gemini-3.8-*`). Claude: `CLAUDE_CONFIG_DIR`; Codex: `CODEX_HOME`.

## Global Constraints

- Vẫn **không API key**: `login.forbidden_env` áp dụng cho cả env của từng agent; `account_env` chỉ nhận khoá trong danh sách trắng `CLAUDE_CONFIG_DIR, CODEX_HOME, AGY_ACCOUNT, ANTIGRAVITY_GEMINI_DIR`; giá trị đường dẫn phải là tuyệt đối và không nằm trong `host.projects_root`.
- Không bao giờ đọc/in/lưu nội dung credential trong các thư mục tài khoản (như Kế hoạch 3).
- `rules.auto_switch_accounts: false` giữ nguyên – Core không tự đổi tài khoản/agent khi hết Energy.
- Luật cứng giữ nguyên với đội hình mới: coder ≠ QC của ticket đó; coder ≠ audit của goal; một agent được kiêm nhiều ghế còn lại (vd PM + Audit, PM + QC).
- Đổi đội hình khi đang có phiên/lượt chạy → từ chối (409), như Kế hoạch 3.
- Test không gọi CLI thật; `npx vitest run` không tăng fail; `npx tsc --noEmit` sạch.

## Review Focus

1. **Một agent kiêm Dev + QC** (vd cùng là `qeen`) → luật coder ≠ QC vẫn chặn khi QC đúng ticket mình code, phiên `needs_owner` rõ lý do, không tự pass. (Task 4)
2. **`account_env` trỏ vào thư mục project hoặc chứa API key / khoá lạ** → config bị từ chối khi load, không chạy phiên. (Task 1)
3. **Hai agent cùng công cụ, khác tài khoản** (vd `kai` và `vic` đều là agy) → Energy/đèn đăng nhập đọc riêng từng tài khoản, hết hạn mức của `kai` không chặn `vic`. (Task 3)
4. **`team/project.yaml` ghi ghế cho agent không tồn tại / không có ghế trong `can_sit`** → bỏ qua override đó, dùng mặc định, dashboard hiện cảnh báo – không crash. (Task 4)
5. **Đổi ghế trên dashboard ở project A** → project B không bị đổi. (Task 4, Task 5)

---

## File Structure

- Modify `src/config.ts` – `agents.<id>.model`, `agents.<id>.account_env`.
- Create `src/agents/env.ts` – `agentEnv(cfg, agentId, baseEnv)`, danh sách trắng, kiểm tra.
- Modify `src/runner/argv.ts`, `src/runner/run.ts` – thêm `--model`, chạy với env của agent.
- Modify `src/energy/quota.ts`, `src/energy/login.ts`, `src/energy/monitor.ts` – đọc theo env của agent.
- Modify `src/store/db.ts` (`effectiveSeats` + khoá setting theo project), `src/ticket/goal.ts` (`readProjectSeats`), `src/core/session.ts`, `src/server/host.ts`, `src/server/http.ts`, `src/server/snapshot.ts`, `src/ticket/goal.ts` (approveGoal) – mọi chỗ gọi `effectiveSeats` truyền `project`.
- Modify `web/index.html` – đổi ghế theo project (cả Audit), mục Tài khoản hiện model + tài khoản + lệnh đăng nhập đúng env.
- Modify `btm.config.yaml`, `docs/spec.md` §3 – ví dụ đội hình.

---

### Task 1: Agent có model + tài khoản riêng (config)

**Files:** Modify `src/config.ts`; Create `src/agents/env.ts`; tests `tests/config.test.ts`, `tests/agent-env.test.ts`.

**Interfaces – Produces:**
- `AgentConfigSchema` thêm `model?: string` (`/^[A-Za-z0-9._:-]{1,80}$/`), `account_env?: Record<'CLAUDE_CONFIG_DIR'|'CODEX_HOME'|'AGY_ACCOUNT'|'ANTIGRAVITY_GEMINI_DIR', string>`.
- `ACCOUNT_ENV_KEYS` (danh sách trắng); khoá theo công cụ: claude-code → `CLAUDE_CONFIG_DIR`; codex-cli → `CODEX_HOME`; antigravity-cli → `AGY_ACCOUNT`, `ANTIGRAVITY_GEMINI_DIR`.
- `agentEnv(cfg: Config, agentId: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv` = base đã xoá mọi khoá `login.forbidden_env` + `account_env` của agent.

- [ ] **Step 1: Test:** config có `kai: {tool: antigravity-cli, model: gemini-3.8-flash-high, account_env: {AGY_ACCOUNT: kai@…}, can_sit: [audit]}` load ok; khoá ngoài danh sách (`OPENAI_API_KEY`, `PATH`) → lỗi; khoá không hợp công cụ (`CODEX_HOME` cho claude-code) → lỗi; đường dẫn tương đối hoặc nằm trong `projects_root` → lỗi; `agentEnv` xoá `ANTHROPIC_API_KEY` khỏi base và thêm `AGY_ACCOUNT`; hai agent khác nhau trả env khác nhau.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: per-agent model and account env (P5 Task 1)`.

### Task 2: Runner chạy đúng model + tài khoản

**Files:** Modify `src/runner/argv.ts`, `src/runner/run.ts`, `src/core/session.ts` (chỗ gọi runner), `src/server/host.ts` (lệnh trực tiếp); tests `tests/argv.test.ts`, `tests/run.test.ts`.

**Interfaces – Consumes:** Task 1. **Produces:** `ArgvOpts` thêm `model?: string`; Runner nhận `env` = `agentEnv(...)` cho mỗi lượt.
- claude-code: `--model <m>`; codex-cli: `-m <m>`; antigravity-cli: `--model <m>` (trong chuỗi lệnh agy, giữ quoting hiện có). Không có `model` → không thêm cờ.
- Mọi lượt (pm/dev/qc/audit + lệnh trực tiếp dashboard) chạy với env của agent đang ngồi ghế.

- [ ] **Step 1: Test:** argv có/không `--model` theo từng công cụ; model có ký tự lạ bị chặn ở Task 1 nên argv không cần quote thêm; runner giả nhận đúng `env.AGY_ACCOUNT` của `kai` cho lượt audit và của `vic` cho lượt dev trong cùng phiên.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: runner uses agent model and account (P5 Task 2)`.

### Task 3: Energy + đèn đăng nhập theo tài khoản

**Files:** Modify `src/energy/quota.ts`, `src/energy/login.ts`, `src/energy/monitor.ts`; tests `tests/quota.test.ts`, `tests/login.test.ts`, `tests/monitor.test.ts`.

- `readEnergy`/`checkLogin` của mỗi agent chạy lệnh đọc (`agy -p /quota`, `claude -p /usage`, `claude auth status`, …) với `agentEnv(agent)`; Codex đọc `sessions/*.jsonl` trong `account_env.CODEX_HOME` (mặc định như cũ).
- Cache và bản ghi SQLite đã theo `agent` id – giữ nguyên.
- `AGY_ACCOUNT` không khớp tài khoản đã đăng nhập → trạng thái `relogin` với ghi chú "Tài khoản <email> chưa đăng nhập trong agy".

- [ ] **Step 1: Test** (output mẫu, không gọi CLI thật): 2 agent agy khác `AGY_ACCOUNT` → lệnh đọc nhận đúng env từng agent; 2 agent codex khác `CODEX_HOME` → đọc đúng thư mục jsonl từng cái; output "matches no signed-in account" → `relogin`; hết Energy của `kai` không chặn lượt của `vic`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: energy and login per agent account (P5 Task 3)`.

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
- Mục Tài khoản: mỗi agent 1 dòng – công cụ, model, tài khoản (email `AGY_ACCOUNT` hoặc tên thư mục cuối của `*_DIR`/`CODEX_HOME`, **không** hiện đường dẫn đầy đủ), đèn đăng nhập, lệnh đăng nhập đúng env để sao chép (vd `ssh -t … "sudo -iu agent env CODEX_HOME=/home/agent/.codex-kai codex login --device-auth"`).
- Cảnh báo từ Task 4 (override bị bỏ qua) hiện trên thanh phiên.
- Giữ a11y, tương phản ≥ 4.5:1, `.seat-footer { margin-top: auto; }`.

- [ ] **Step 1: Test:** snapshot có model/tài khoản/nhãn kiêm nhiệm đúng; web có select cho ghế audit; lệnh đăng nhập chứa đúng `CODEX_HOME=` của agent; không lộ đường dẫn đầy đủ trong text hiển thị; nội dung chèn bằng `textContent`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Cheki mở dashboard demo đo/chụp (như P4-T9).
- [ ] **Step 6:** Commit `feat: dashboard seats per project, accounts with model (P5 Task 5)`.

### Task 6: Cấu hình mẫu + tài liệu

**Files:** Modify `btm.config.yaml`, `docs/spec.md` §3; Create `docs/team-setup.md`.

- `btm.config.yaml`: thêm ví dụ (comment) – `kai` agy + Gemini + `AGY_ACCOUNT`; `qeen` codex có `audit` trong `can_sit`; Claude kiêm PM + Audit qua `team/project.yaml`.
- `docs/team-setup.md` (≤ 1 trang): thêm tài khoản mới cho từng công cụ (lệnh đăng nhập dưới user `agent` với env riêng), gắn agent vào ghế, đội hình theo project, luật kiêm nhiệm được/không được.
- [ ] **Step 1:** `loadConfig(btm.config.yaml)` vẫn hợp lệ (test có sẵn). **Step 2:** Commit `docs: flexible team setup (P5 Task 6)`.

---

## Để sau

Thêm/sửa agent ngay trên dashboard (hiện sửa `btm.config.yaml`); tự đề xuất người thay khi một agent hết Energy (v2.x); nhiều agent chạy song song (v2.0).
