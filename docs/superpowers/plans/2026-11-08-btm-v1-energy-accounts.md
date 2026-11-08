# BTM v1.0 – Kế hoạch 3: Energy, đăng nhập, đổi ghế, OpenSpec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy ở dự án này:** Cheki giao **Victor** (agy) qua `btm-task`, **Qeen** (codex read-only) review; Cheki commit/push. Nhánh `plan3-energy`.

**Goal:** Thẻ ghế hiện Energy thật (5 giờ / tuần, % còn, giờ hồi) và đèn đăng nhập; Core không giao lượt cho ghế hết Energy hoặc mất đăng nhập; anh đổi người ngồi ghế trên dashboard; project mới có OpenSpec.

**Architecture:** Đọc hạn mức **chỉ đọc, không tốn token**: agy qua `agy -p /quota --output-format json` (lệnh chính thức, đã chạy thử 2026-11-08), Codex qua `rate_limits` trong `~/.codex/sessions/**/*.jsonl` mà chính codex ghi sau mỗi lượt. Claude: CLI không có lệnh hạn mức → Energy `unknown` (chỉ có đèn đăng nhập từ `claude auth status`). Kết quả lưu SQLite có cache; đọc khi mở phiên, trước mỗi lượt, và khi anh bấm "Làm mới".

**Tech Stack:** như Kế hoạch 1–2 (Node 22, TS, vitest, node:http, HTML thuần).

**Spec:** `docs/spec.md` §8 (Energy và đăng nhập), §10 (Khi một agent nghỉ), §12 (plugin); `btm.config.yaml` mục `energy`, `login`, `rules`, `seats`, `agents`.

**Lệch spec có chủ đích (Ruling):**
- Claude Energy = `unknown`: không dùng token đăng nhập gọi endpoint không công khai (spec §8 cho phép nhưng rủi ro token + dễ gãy). Nâng cấp sau nếu anh cần.
- Trang Tài khoản v1 **không** chuyển tiếp link/mã đăng nhập qua web: hiện trạng thái + lệnh đăng nhập chính xác (nút sao chép) chạy qua SSH dưới user `agent`.

## Global Constraints

- Không bao giờ đọc, in, lưu hay gửi nội dung token/credential (`~/.codex/auth.json`, `~/.claude/.credentials.json`, `~/.gemini/**/oauth*`). Chỉ đọc file `sessions/*.jsonl` của codex và output lệnh CLI.
- Đọc hạn mức không gọi model: agy chỉ dùng `/quota`; không chạy `codex exec`/`claude -p` để thăm dò.
- Đọc lỗi/timeout (≤ 60 s) → trạng thái `unknown`, **không chặn phiên** (spec §8). Chỉ chặn khi đọc được và dưới `energy.min_remaining_percent`.
- Cache theo `energy.cache_seconds`; nút "Làm mới" cũng tôn trọng cache tối thiểu 30 s.
- Không tự chuyển tài khoản (`rules.auto_switch_accounts: false`).
- Mọi POST mới đi qua guard sẵn có (x-btm, Origin, JSON).
- `npx vitest run` + `npx tsc --noEmit` sạch; test không gọi CLI thật (dùng output mẫu).

## Review Focus

1. **Output `/quota` đổi định dạng / rỗng / agy mất đăng nhập** → `unknown` hoặc `relogin`, không crash, không chặn phiên. (Task 1)
2. **Không có file jsonl codex / file đang ghi dở / dòng hỏng** → bỏ dòng hỏng, lấy bản ghi hợp lệ mới nhất; không có → `unknown`. (Task 1)
3. **Hết Energy giữa phiên** → lượt kế tiếp của ghế đó không chạy, phiên `needs_owner` kèm giờ hồi; ghế khác không bị ảnh hưởng sai. (Task 3)
4. **Đổi ghế khi phiên đang chạy** → từ chối; đổi sang agent không có ghế đó trong `can_sit` → 400. (Task 5)
5. **Biến API key bị đặt trong môi trường service** → đèn đỏ "API key đè đăng nhập", phiên bị từ chối như Kế hoạch 1. (Task 2)

---

### Task 1: Đọc hạn mức

**Files:** Create `src/energy/quota.ts`, `tests/quota.test.ts`

**Interfaces — Produces:**
```ts
export interface EnergyWindow { name: '5h' | 'week'; remainingPercent: number; resetsAt: string } // ISO
export interface EnergyReading { agent: string; status: 'fresh' | 'unknown'; windows: EnergyWindow[]; readAt: string; note?: string }
export function parseAgyQuota(json: string, group?: string): EnergyWindow[] | null; // group mặc định 'Gemini Models'
export function readCodexLimits(codexHome: string): { windows: EnergyWindow[]; at: string } | null;
export function readEnergy(agent: string, tool: Tool, deps: { run: (argv: string[]) => Promise<ProcResult>; codexHome: string; now: () => Date }): Promise<EnergyReading>;
```
- `parseAgyQuota`: đọc trường `response` (các dòng tab: nhóm, tên giới hạn, `NN%`, ISO); lấy 2 dòng của nhóm `group`: "Five Hour Limit Remaining" → `5h`, "Weekly Limit Remaining" → `week`. Thiếu → `null`.
- `readCodexLimits`: file `*.jsonl` mới nhất (mtime) dưới `codexHome/sessions`; quét từ cuối lên, dòng đầu tiên parse được có `rate_limits.primary/secondary` → `remainingPercent = 100 - used_percent`, `resetsAt = new Date(resets_at*1000)`; `primary` (300 phút) = `5h`, `secondary` (10080 phút) = `week`.
- `readEnergy`: antigravity-cli → chạy `['script','-qec','agy -p /quota --output-format json --print-timeout 50s','/dev/null']` qua `deps.run` (timeout 60 s), lấy JSON trong output; codex-cli → `readCodexLimits`; claude-code → `unknown` với `note: 'CLI không có lệnh hạn mức'`. Mọi lỗi → `unknown` + `note` ngắn.

- [ ] **Step 1: Test** với output mẫu thật (chép từ phiên 2026-11-08: `Gemini Models\tWeekly Limit Remaining\t63%\t2026-11-15T00:22:39Z`, `…Five Hour Limit Remaining\t83%…`, cùng 2 dòng "Claude and GPT models") → `[{name:'5h',remainingPercent:83,…},{name:'week',remainingPercent:63,…}]`; JSON hỏng/thiếu dòng → `null`; jsonl có dòng cuối hỏng + dòng trước hợp lệ (`used_percent: 4.0` / `30.0`) → `96` / `70`; không có thư mục sessions → `null`; `readEnergy` với run giả ném lỗi → `unknown`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: quota readers".

### Task 2: Đèn đăng nhập

**Files:** Create `src/energy/login.ts`, `tests/login.test.ts`

**Interfaces — Produces:**
```ts
export type LoginState = 'ok' | 'expiring' | 'relogin' | 'api_key' | 'unknown';
export interface LoginHealth { agent: string; state: LoginState; detail: string; expiresAt?: string }
export function checkLogin(agent: string, tool: Tool, deps: { run: (argv: string[]) => Promise<ProcResult>; env: NodeJS.ProcessEnv; cfg: Config; now: () => Date; agyQuotaOk?: boolean }): Promise<LoginHealth>;
```
- Trước hết: `checkForbiddenEnv(env, cfg.login.forbidden_env)` không rỗng → `api_key` cho mọi agent.
- claude-code: `claude auth status` (JSON): `loggedIn` false → `relogin`; `loginExpiresAt` còn < `login.warn_expiry_days` ngày → `expiring` (detail "Hết hạn dd/mm"); còn lại `ok`.
- codex-cli: `codex login status`: exit 0 và chứa "Logged in using ChatGPT" → `ok`; chứa "API key" → `api_key`; khác → `relogin`.
- antigravity-cli: không có lệnh trạng thái riêng → dùng kết quả Task 1: `/quota` thành công → `ok`; output có "login"/"sign in"/"auth" → `relogin`; còn lại `unknown`.
- [ ] **Step 1: Test** từng nhánh bằng output mẫu (claude JSON có `loginExpiresAt` cách 3 ngày → `expiring`, 30 ngày → `ok`; codex "Not logged in" → `relogin`; env có `OPENAI_API_KEY` → `api_key`).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: login health".

### Task 3: Lưu, cache và chặn lượt

**Files:** Modify `src/store/db.ts`, `src/core/session.ts`, `src/server/host.ts`; Create `src/energy/monitor.ts`; tests tương ứng.

**Interfaces — Produces:**
```ts
// store
saveEnergy(r: EnergyReading): void; latestEnergy(agent: string): EnergyReading | null;
saveLogin(h: LoginHealth): void; latestLogin(agent: string): LoginHealth | null;
// monitor
export function createMonitor(d: { cfg: Config; store: Store; readEnergy: typeof readEnergy; checkLogin: typeof checkLogin; now: () => Date }): {
  refresh(agents: string[], force?: boolean): Promise<void>;           // tôn trọng cache_seconds (force: tối thiểu 30 s)
  gate(agent: string): { ok: true } | { ok: false; reason: string };    // dùng bản đọc gần nhất
};
```
- `gate`: login `relogin`/`api_key` → `{ok:false, reason:'login:<state>'}`; energy `fresh` và `min(remainingPercent) < energy.min_remaining_percent` → `{ok:false, reason:'energy:<cửa sổ> còn N%, hồi lúc HH:mm'}`; `unknown` → ok.
- `SessionDeps` thêm `gate?: (agent: string) => …`; mở phiên: `refresh(mọi agent đang ngồi ghế)` nếu `energy.read_on` có `session_open`; trước mỗi lượt: `refresh([agent])` nếu có `before_turn`, rồi `gate(agent)`; không ok → không gọi runner, `recordHandoffFailure(…, reason)`, phiên `needs_owner`, note = reason.
- [ ] **Step 1: Test** (đọc giả): energy 15% với ngưỡng 20 → lượt Dev không chạy, `needs_owner`, note có "hồi lúc"; energy `unknown` → chạy; login `relogin` cho QC → Dev vẫn chạy, tới QC thì dừng; cache: 2 lần `refresh` trong `cache_seconds` chỉ đọc 1 lần.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: energy gate".

### Task 4: Dashboard – Energy, đèn, trang Tài khoản

**Files:** Modify `src/server/snapshot.ts`, `src/server/http.ts`, `web/index.html`; tests tương ứng.

- Snapshot `seats[].energy` = `{ status, windows, readAt, note }`, `seats[].login` = `{ state, detail }` (thay `'—'`).
- `POST /api/energy/refresh {}` → `monitor.refresh(all, true)`.
- Thẻ ghế: hai thanh ngang nhỏ "5 giờ" và "Tuần" (độ dài = % còn; màu xanh lá ≥ 50, vàng 20–49, đỏ < 20; chữ "còn N% · hồi HH:mm"); `unknown` → "Energy: không đọc được" + `note`. Đèn đăng nhập: chấm tròn + chữ (Ổn / Sắp hết hạn dd/mm / Cần đăng nhập lại / API key đè / Chưa rõ). Nút "Làm mới Energy" trên thanh trên.
- Khu **Tài khoản** (cuối trang): mỗi agent một dòng: tên, công cụ, đèn, chi tiết, và lệnh đăng nhập lại dạng mã + nút "Sao chép":
  - claude: `ssh -t admzon@<host> "sudo -iu agent claude auth login"`
  - codex: `ssh -t admzon@<host> "sudo -iu agent codex login --device-auth"`
  - agy: `ssh -t admzon@<host> "sudo -iu agent agy"`
  (`<host>` = `location.hostname` nếu không phải localhost, ngược lại hằng `cfg.host.ssh_hint` — thêm khóa tuỳ chọn `host.ssh_hint` vào config/schema, mặc định `admzon@100.96.250.103`).
- [ ] **Step 1: Test** snapshot có energy/login thật từ store; route refresh có guard; web: thanh energy có `role="meter"` + `aria-valuenow`, nút Sao chép có `aria-label`, không innerHTML.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: energy + accounts on dashboard". **Step 6 (Cheki):** xem thật ở 8080, bấm Làm mới, đối chiếu số với `agy -p /quota`.

### Task 5: Đổi người ngồi ghế + bàn giao

**Files:** Modify `src/store/db.ts`, `src/server/host.ts`, `src/server/http.ts`, `src/core/session.ts`, `src/core/prompts.ts`, `src/server/snapshot.ts`, `web/index.html`; tests tương ứng.

- Store setting `seat:<seat>` ghi đè `cfg.seats[seat]`; `effectiveSeats(cfg, store)` dùng ở mọi nơi đang đọc `cfg.seats`.
- `POST /api/seat {seat, agent}`: phiên/lượt đang chạy → 409; `agent` không có `seat` trong `can_sit` → 400; ok → lưu, log "Đổi ghế dev: jacky → jenny".
- Bàn giao: khi Dev của một thẻ đang `returned`/`in_dev` khác agent đã code thẻ đó trước, `devPrompt` thêm: "Bàn giao: đọc git log nhánh phiên và team/reports/<id>-dev.md trước khi sửa". Luật `coder_cannot_qc_same_task` giữ nguyên (đã có).
- Web: trên mỗi thẻ ghế một `<select>` có label "Người ngồi ghế" liệt kê agent có `can_sit` chứa ghế đó; đổi → POST; khi bận thì disabled.
- [ ] **Step 1: Test**: đổi dev sang jenny → lượt Dev kế tiếp gọi runner với `jenny`; jenny đã code thẻ → QC không được là jenny (needs_owner như cũ); đổi khi đang chạy → 409; agent không hợp lệ → 400; prompt bàn giao xuất hiện khi coder trước khác.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: seat swap + handoff".

### Task 6: OpenSpec cho project mới

**Files:** Modify `src/project/init.ts`, `src/core/prompts.ts`, `tests/init.test.ts`

- `initProject`: sau `git init`, chạy `openspec init --tools claude,codex,antigravity --language vi --no-animation` trong thư mục project (timeout 60 s); lỗi → ghi cảnh báo vào `docs/README-btm.md` và tiếp tục (không chặn init). Commit "init" gồm cả `openspec/`.
- `pmPrompt`: nếu project có thư mục `openspec/` → dặn PM đề xuất thay đổi bằng OpenSpec (`openspec/changes/<tên>`), mỗi thẻ ghi `openspec_change: <tên>`.
- [ ] **Step 1: Test** với `openspec` giả trên PATH (script ghi file đánh dấu) → init gọi đúng tham số; openspec lỗi → init vẫn thành công + có cảnh báo; pmPrompt có/không có dòng OpenSpec theo thư mục.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: openspec on project init". **Step 6 (Cheki):** tạo project thử `moon-lab`, kiểm tra `openspec/` có thật.

---

## Để sau (không làm trong kế hoạch này)

- Energy của Claude qua endpoint không công khai (cần token) — chỉ làm khi anh yêu cầu.
- Đăng nhập lại ngay trên dashboard (chuyển tiếp link/mã) — hiện dùng lệnh SSH có nút sao chép.
- Tự đề xuất người thay khi một agent "nghỉ" (v2.x).
