# BTM – Kế hoạch 7: Accounts (Worker nhiều tài khoản) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy ở dự án này:** Cheki code (anh Zon cho phép từ Plan 5), test local + VM ×3, review độc lập, tự merge; deploy chờ anh Zon. Nhánh `plan7-accounts` tạo từ `main`.

**Goal:** Mỗi Worker (elon/jacky/jenny) có danh sách tài khoản theo thứ tự. Anh thêm tài khoản trên dashboard, export/import kho dạng JSON, bật/tắt tài khoản theo từng máy. Khi tài khoản đang dùng hết quota, app tự đổi sang tài khoản kế tiếp còn dùng được.

**Architecture:**
- **Tài khoản** = một user Linux. Khoá tài khoản (`accountKey`) là `jacky` cho tài khoản `default`, và `jacky-<slug>` cho các tài khoản khác.
- Mọi chỗ hiện đang dùng agent id để ra user Linux, workspace, energy, đăng nhập và `usage_limited_until`, sau plan này đều dùng **khoá tài khoản**. Nhờ vậy dữ liệu cũ của tài khoản `default` giữ nguyên.
- **Chọn tài khoản ở một chỗ duy nhất**: `withUsageLimit` trong session. Nó truyền `options.account` cho runner và đánh dấu giới hạn quota theo tài khoản.
- **Quyền root** chỉ qua một wrapper mới `btm-account`, chỉ có 3 lệnh `add` / `export` / `import`.

**Tech Stack:** như Kế hoạch 1–6.

**Spec:** `docs/superpowers/specs/2026-11-12-accounts-design.md` (anh Zon duyệt 2026-11-12).

**Đã kiểm tra trước (VM, 2026-11-12):**
- `codex login --device-auth` có tồn tại.
- `claude auth login` có tồn tại, có cờ `--email`.
- `agy --help` không có lệnh login.

## Global Constraints

- Không dùng API key. `login.forbidden_env` giữ nguyên. Không đọc, in, log hay commit nội dung token, **trừ** đường export/import mà anh Zon đã duyệt (JSON trần, decision 0005).
- **Tài khoản ngủ** (`active = 0`): không gọi `wrapForWorker` / `btm-worker-exec` bằng user của tài khoản đó, dù để chạy lượt, đọc energy hay kiểm tra đăng nhập. Chỉ `btm-account export|import` được đọc hoặc ghi file token của tài khoản ngủ.
- Khoá tài khoản `default` **bằng agent id**. Người ký commit, ghế và log vẫn dùng agent id. Trên UI gọi là **Worker** / **Account**. Tên trong code giữ nguyên (`cfg.agents`, `worker_prefix`).
- `slug`: `/^[a-z0-9]{1,12}$/` và khác `default`. `accountKey` phải hợp lệ cho `workerUser`, và không được trùng id của agent khác.
- Thứ tự và cờ `active` lưu trong DB, áp dụng cho cả máy, không phụ thuộc project. File export **không** chứa `active` và `ord`.
- Tài khoản tạo bằng Add Account mặc định `active = 1`. Tài khoản import mặc định `active = 0`. Tài khoản mới đứng cuối thứ tự.
- `rules.auto_switch_accounts`: bỏ `z.literal(false)`, đổi thành `z.boolean().default(true)`. Đặt `false` thì chỉ dùng tài khoản đầu tiên (hành vi cũ). Cập nhật chú thích trong `btm.config.yaml`.
- Chế độ không cách ly (Windows/dev): chỉ có tài khoản `default`. Add Account và Import trả 409 `isolation required`.
- Chữ trên UI đi qua `STRINGS.en` / `tx()` và thêm dòng vào `docs/i18n-strings.md`. Dữ liệu hiển thị bằng `textContent`.
- Test không gọi CLI hay sudo thật (dùng `exec` giả). `npx vitest run` không tăng số test fail. `npx tsc --noEmit` sạch.

## Review Focus

1. **Tài khoản ngủ bị đụng tới**: monitor, kiểm tra đăng nhập hoặc runner gọi exec bằng `btm-jacky-b` khi tài khoản này đang ngủ. Mong đợi: không có lệnh nào. (Task 2, test exec spy)
2. **Token lọt ra ngoài**: snapshot/SSE, thông báo lỗi của API, ntfy, `console.log`. Mong đợi: chuỗi token mẫu `tok-SECRET-123` không xuất hiện ở đâu, trừ body của response export. (Task 3, Task 4)
3. **File import độc hại hoặc hỏng**: tên file `../../.ssh/authorized_keys`, tool không khớp, agent lạ, slug sai, JSON hỏng, file 10 MB. Mong đợi: bỏ từng mục lỗi kèm lý do, không ghi gì ngoài đúng các file token cố định. (Task 3, Task 4)
4. **Nâng cấp trên VM đang chạy**: `usage_limited_until:jacky`, energy và login cũ vẫn dùng được; không phải đăng nhập lại; người ký commit không đổi. (Task 1, Task 2)
5. **Worker hết sạch tài khoản giữa phiên**: chuyển sang agent dự phòng của ghế; không còn ai thì dừng và gửi ntfy; auto-resume không lặp vô hạn. (Task 2)

---

## File Structure

- Create `src/agents/accounts.ts`: khoá tài khoản, kiểm tra slug, chọn tài khoản.
- Modify `src/store/db.ts`: bảng `accounts` và các method.
- Modify `src/core/session.ts`: `withUsageLimit`, `pickSeatAgent`.
- Modify `src/runner/run.ts`: `options.account`.
- Modify `src/energy/monitor.ts`, `src/energy/login.ts`: chạy theo khoá tài khoản, chỉ tài khoản đang bật.
- Modify `src/notify/notify.ts`: thêm các kind mới.
- Create `src/isolation/account-admin.ts`: client TS gọi `btm-account`.
- Modify `deploy/isolation-setup.sh`, `docs/deploy-isolation.md`.
- Create `src/agents/login-flow.ts`: đăng nhập codex/claude trên dashboard.
- Modify `src/server/http.ts`, `src/server/snapshot.ts`.
- Modify `web/index.html`.
- Create `docs/decisions/0005-account-export.md`.

---

### Task 1: Kho tài khoản (store + chọn tài khoản)

**Files:** Create `src/agents/accounts.ts`. Modify `src/store/db.ts`, `src/config.ts` (`auto_switch_accounts`). Tests `tests/accounts.test.ts`, `tests/store.test.ts`.

**Interfaces – Produces:**
- `interface AccountRow { agent: string; slug: string; email: string | null; label: 'none'|'ide'|'cli'|'plugin'|'other'; active: boolean; ord: number; created_at: string }`
- `accountKey(agent: string, slug: string): string`: trả `agent` khi `slug === 'default'`, ngược lại `` `${agent}-${slug}` ``.
- `validateSlug(cfg: Config, agent: string, slug: string): string | null`: trả lý do lỗi, hoặc null nếu hợp lệ.
- Store:
  - `ensureDefaultAccounts(agents: string[]): void`: tạo dòng `default`, active, ord 0, nếu chưa có.
  - `listAccounts(agent?: string): AccountRow[]`: sắp theo `agent, ord`.
  - `getAccount(agent, slug)`
  - `addAccount(agent, slug, opts: { email?: string|null; label?: AccountRow['label']; active: boolean }): AccountRow`: tự gán `ord = max + 1`.
  - `updateAccount(agent, slug, patch: Partial<Pick<AccountRow,'email'|'label'|'active'>>)`
  - `moveAccount(agent, slug, dir: 'up'|'down')`
- `pickAccount(cfg, store, agent, now = new Date()): { key: string; slug: string } | null`: tài khoản đầu tiên theo `ord` thoả cả ba điều kiện:
  - `active`;
  - `usage_limited_until:<key>` không tồn tại hoặc đã qua;
  - lần kiểm tra đăng nhập gần nhất của `<key>` không phải `relogin` (chưa kiểm tra lần nào vẫn được tính là dùng được).

  Khi `auto_switch_accounts === false`, chỉ xét tài khoản đầu tiên đang bật.

- [ ] **Step 1: Test** (`tests/accounts.test.ts`):
  - `accountKey('jacky','default') === 'jacky'`; `accountKey('jacky','b') === 'jacky-b'`.
  - `validateSlug` từ chối `'default'`, `'B'`, `'a_b'`, `'x'.repeat(13)`, và slug làm `accountKey` trùng một agent khác (config có agent `jacky-b`).
  - Thứ tự `a(default), b, c`. a bị giới hạn đến +1h → chọn b. b cũng bị giới hạn → chọn c. c đang ngủ → null.
  - Giờ reset của a đã qua → chọn lại a.
  - Lần kiểm tra đăng nhập gần nhất của b là `relogin` → bỏ qua b.
  - `auto_switch_accounts: false` và a bị giới hạn → null.
- [ ] **Step 2: Test store:** `ensureDefaultAccounts` gọi 2 lần vẫn chỉ có 1 dòng. `moveAccount` đổi `ord`, gọi ở hai đầu danh sách thì không làm gì. `addAccount` trùng → throw.
- [ ] **Step 3–4:** Chạy test (FAIL), implement, chạy lại (PASS). Gọi `ensureDefaultAccounts(Object.keys(cfg.agents))` khi `serve` khởi động.
- [ ] **Step 5:** Commit `feat: accounts store and picker (P7 Task 1)`.

### Task 2: Chạy theo tài khoản (runner, session, energy, login, ntfy)

**Files:** Modify `src/core/session.ts`, `src/runner/run.ts`, `src/energy/monitor.ts`, `src/energy/login.ts`, `src/server/host.ts`, `src/notify/notify.ts`, `src/server/http.ts` (`/api/energy/refresh`). Tests `tests/session.test.ts`, `tests/run.test.ts`, `tests/monitor.test.ts`, `tests/notify.test.ts`.

**Interfaces:**
- Consumes: `pickAccount`, `accountKey`, `listAccounts` (Task 1).
- Produces:
  - `RunnerOptions.account?: string` (khoá tài khoản). `makeRunner` dùng `options.account ?? agentId` cho `wrapForWorker`, `workerKillAll`, reset, sync, `workspacePath`, `workerOutFile` và import.
  - `activeAccountKeys(cfg, store): string[]`
  - `agentOfAccount(cfg, store, key): string | null`
  - Monitor `refresh(keys)`, `gate(key)` và kiểm tra đăng nhập nhận **khoá tài khoản**, tra `tool` qua `agentOfAccount`. Monitor chạy định kỳ chỉ trên `activeAccountKeys`.
  - `NotifyKind` thêm `'account_switch' | 'account_logout'`.
  - Setting `account_last:<agent>` lưu khoá tài khoản đã chạy lượt gần nhất.
- `withUsageLimit`:
  - Gọi `pickAccount`. Không còn tài khoản nào thì throw `usage_limit_hit:<agent>`, đúng đường cũ.
  - Truyền `account` cho runner. Khi bị giới hạn thì ghi `usageLimitedKey(<key>)`.
  - Khoá tài khoản khác `account_last:<agent>` thì gửi ntfy `account_switch` với nội dung `jacky: <slug cũ> → <slug mới>`, rồi cập nhật `account_last`.
- `pickSeatAgent`:
  - Thay kiểm tra `usageLimitedKey(agent)` bằng `pickAccount(...) === null`, lý do `usage_limited:<agent>`.
  - Gọi `refreshFn` và `gateFn` trên khoá của tài khoản được chọn.
- Kiểm tra đăng nhập chuyển từ `ok` sang `relogin` trên một tài khoản đang bật thì gửi ntfy `account_logout`, nội dung `<agent>/<slug> logged out – maybe used on another machine`. Áp dụng dedupe 10 phút như hiện nay.

- [ ] **Step 1: Test session:**
  - Tài khoản a của jacky trả output giới hạn quota → `usage_limited_until:jacky` được ghi, sau đó lượt resume chạy với `options.account === 'jacky-b'`.
  - Ntfy `account_switch` được gửi đúng 1 lần.
  - Cả a và b đều bị giới hạn, có `seats_backup.dev: [jenny]` → jenny ngồi thay.
  - Không có ai dự phòng → `needs_owner` với `all_agents_exhausted`.
- [ ] **Step 2: Test run:** `options.account: 'jacky-b'` → argv bắt đầu bằng `sudo -n -u btm-jacky-b`, workspace `/srv/btm-work/btm-jacky-b/<project>`.
- [ ] **Step 3: Test monitor (Review Focus 1):** dùng exec spy. Một vòng refresh và kiểm tra đăng nhập không có argv nào chứa `btm-jacky-c` (tài khoản ngủ). Bật c lên thì có.
- [ ] **Step 4: Test login:** `ok` chuyển sang `relogin` gửi 1 ntfy `account_logout`. Lần kiểm tra thứ hai vẫn `relogin` thì không gửi thêm.
- [ ] **Step 5: Test nâng cấp (Review Focus 4):** store cũ có `usage_limited_until:jacky` và energy của `jacky`. Sau `ensureDefaultAccounts`, `pickAccount` đọc đúng các dữ liệu đó.
- [ ] **Step 6–7:** FAIL → implement → PASS. Chạy toàn bộ test để chắc các test cũ của session/host vẫn xanh.
- [ ] **Step 8:** Commit `feat: run, energy and login per account; switch and logout ntfy (P7 Task 2)`.

### Task 3: Wrapper `btm-account` + client TS + định dạng token agy

**Files:** Modify `deploy/isolation-setup.sh` (bước prep cài `/usr/local/bin/btm-account` và thêm sudoers cho `agent`), `docs/deploy-isolation.md`. Create `src/isolation/account-admin.ts`, `docs/decisions/0005-account-export.md`. Tests `tests/account-admin.test.ts`. Kiểm tra trên VM bằng cách thêm vào `team/bin/p45-attack-check.mjs`.

**Interfaces – Produces:**
- `TOKEN_FILES: Record<Tool, string[]>`, đường dẫn tương đối với home, khớp đúng danh sách trong wrapper:
  - claude-code: `['.claude/.credentials.json']`
  - codex-cli: `['.codex/auth.json']`
  - antigravity-cli: `['.gemini/antigravity-cli/antigravity-oauth-token']`
- `addWorkerUser(cfg, key, exec): void`, chạy `sudo -n /usr/local/bin/btm-account add <user>`.
- `exportTokens(cfg, key, tool, exec): Record<string, string>`. Wrapper in ra JSON `{"<relpath>": "<nội dung>"}`. File không tồn tại thì bỏ qua.
- `importTokens(cfg, key, tool, files: Record<string,string>, exec): void`. Gửi JSON qua stdin. Phía TS từ chối mọi key không có trong `TOKEN_FILES[tool]` trước khi gọi sudo.
- `agyFilesFromJson(input: {email: string; refresh_token: string}): Record<string,string>`: dựng nội dung file token agy theo định dạng thật.

Quy tắc của wrapper (bash, `set -euo pipefail`):
- user khớp `^btm-[a-z0-9-]{1,28}$`;
- với `export` và `import`, user phải thuộc nhóm `btm-workers`;
- tool chỉ là `claude-code|codex-cli|antigravity-cli`;
- `import` ghi bằng `install -o <user> -g <user> -m 0600` vào file tạm cùng thư mục rồi `mv`, sau khi kiểm tra không có thành phần nào trong đường dẫn là symlink;
- stdin tối đa 256 KB;
- lỗi chỉ in mã lỗi, không bao giờ in lại nội dung stdin.

- [ ] **Step 0 (VM, không in giá trị):** chạy lệnh sau dưới quyền `btm-jacky` để xem **tên key** trong file token agy:
  ```bash
  sudo -u btm-jacky python3 -c 'import json;d=json.load(open("/home/btm-jacky/.gemini/antigravity-cli/antigravity-oauth-token"));print(sorted(d) if isinstance(d,dict) else type(d).__name__)'
  ```
  Ghi danh sách key vào decision 0005. Nếu file không phải JSON chứa được `refresh_token`, **dừng lại và báo anh Zon**: khi đó cách nhập agy bằng JSON phải thiết kế lại.
- [ ] **Step 1: Test** (exec giả):
  - `importTokens` với key `../../.ssh/authorized_keys` → throw, exec không được gọi.
  - `importTokens` codex chỉ gửi `.codex/auth.json`.
  - Exec trả lỗi kèm stderr chứa `tok-SECRET-123` → message của lỗi throw ra không chứa chuỗi này.
  - `agyFilesFromJson` thiếu `refresh_token` → throw.
- [ ] **Step 2–3:** FAIL → implement → PASS.
- [ ] **Step 4: VM attack-check** (bổ sung vào `p45-attack-check.mjs`). Các lệnh sau phải bị từ chối, và `/root` cùng `/home/admzon` không có thay đổi gì:
  - `btm-account import root claude-code`
  - `btm-account import admzon codex-cli`
  - import với symlink `.codex` → `/root`
  - stdin 300 KB
- [ ] **Step 5:** Viết decision 0005: token OAuth nằm trong file export dạng JSON trần; anh Zon tự giữ file đó; chỉ export/import được đọc file token.
- [ ] **Step 6:** Commit `feat: btm-account wrapper and token export/import client (P7 Task 3)`.

### Task 4: API Accounts (thêm, đăng nhập, sửa, export, import)

**Files:** Create `src/agents/login-flow.ts`. Modify `src/server/http.ts`, `src/server/snapshot.ts`. Tests `tests/http.test.ts`, `tests/login-flow.test.ts`, `tests/snapshot.test.ts`.

**Interfaces:**
- Consumes: Task 1 (store), Task 3 (`addWorkerUser`, `exportTokens`, `importTokens`, `agyFilesFromJson`).
- Produces:
  - Snapshot `workers: WorkerCard[]`, trong đó `WorkerCard = AccountCard (cũ) + accounts: AccountItem[]`.
  - `AccountItem = { key, slug, email, label, active, status: 'in_use'|'next'|'free'|'limited'|'sleeping'|'relogin', resetsAt: string|null, energy, login }`.
  - Giữ trường `accounts` cũ cho đến Task 5 rồi xoá.
  - `login-flow.ts`:
    - `startLogin(cfg, key, tool, spawnFn): { id: string }`
    - `loginState(id): { state: 'waiting'|'needs_code'|'done'|'failed'; url?: string; code?: string; error?: string }`
    - `sendLoginCode(id, code: string): void`
  - Mỗi lúc chỉ có 1 flow. Timeout 10 phút.
  - Lấy `url` bằng regex `https://[^\s"']+`. Lấy `code` của codex bằng `/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/`.
  - Output của CLI **không** lưu ra log.

Các endpoint (đều qua guard `x-btm` + Origin; các thao tác thay đổi dữ liệu trả 409 khi `host.busy()`, trừ đổi `label`):
- `POST /api/accounts {agent, slug, agy?: {email, refresh_token}}`: kiểm tra slug, `addWorkerUser`, rồi:
  - agy: `importTokens(agyFilesFromJson(...))`, trả 200 `{key}`;
  - codex/claude: `startLogin`, trả 200 `{key, loginId}`.
- `GET /api/accounts/login/:id`: trả `loginState`.
- `POST /api/accounts/login/:id/code {code}`: code tối đa 200 ký tự, một dòng.
- `POST /api/accounts/:key {label?, active?, move?}`.
- `POST /api/accounts/export {}`: trả `Content-Disposition: attachment; filename="btm-accounts-<yyyymmdd>.json"`, `Cache-Control: no-store`. Body là `{version: 1, accounts: [{agent, slug, tool, email, label, files}]}`.
- `POST /api/accounts/import {file, overwrite?: string[], dryRun?: boolean}`: body tối đa 2 MB.
  - Mỗi mục được kiểm tra riêng: agent có tồn tại, `tool` khớp, slug hợp lệ, `files` chỉ chứa các key trong `TOKEN_FILES`.
  - `dryRun` trả `{new: [], conflicts: [], rejected: [{entry, reason}]}`.
  - Khi chạy thật, mục bị trùng chỉ được ghi đè nếu key có trong `overwrite`. Mục mới tạo với `active = 0`.

- [ ] **Step 1: Test http:**
  - Agent lạ → 400. Slug sai → 400. Trùng → 409. Đang bận → 409.
  - Thêm agy: gọi exec với user `btm-jacky-b`, response không chứa `refresh_token`.
  - `/api/accounts/:key {active:false}` → `listAccounts` có `active = false`.
  - Export trả đúng header. Body chứa `tok-SECRET-123` (exec giả trả về) và không có `active`/`ord`.
  - `dryRun` với file có mục `../../x`, tool không khớp, agent lạ, mục trùng → các mục được xếp đúng nhóm.
  - Import chạy thật không có `overwrite` → không đụng tài khoản trùng.
  - Mục mới import có `active = false`.
- [ ] **Step 2: Test Review Focus 2:**
  - `JSON.stringify(buildSnapshot(...))` không chứa `tok-SECRET-123`.
  - `console.log`/`console.error` (spy) trong lúc export/import không chứa chuỗi này.
- [ ] **Step 3: Test login-flow** (spawn giả):
  - codex in `Open https://auth.openai.com/device and enter ABCD-12345` → `waiting`, `url` và `code` đúng; tiến trình thoát với mã 0 → `done`.
  - claude in URL rồi chờ stdin → `needs_code`; `sendLoginCode` ghi `code\n` vào stdin.
  - Quá 10 phút (fake timers) → `failed` và kill tiến trình.
- [ ] **Step 4–5:** FAIL → implement → PASS.
- [ ] **Step 6:** Commit `feat: accounts API with dashboard login, export and import (P7 Task 4)`.

### Task 5: Giao diện Accounts

**Files:** Modify `web/index.html`, `docs/i18n-strings.md`. Tests `tests/web.test.ts`.

**Interfaces – Consumes:** snapshot `workers` và các endpoint của Task 4.

- **Tiêu đề khu Accounts:** 4 nút `Import`, `Export`, `Refresh energy` (chuyển từ thanh phiên xuống; **xoá** nút cũ trên thanh phiên), `Add Account`.
- **Tab:** `All · BTM · IDE · CLI · Plugin`. Tab BTM = tài khoản đang bật. IDE/CLI/Plugin lọc theo `label`. Tab đang chọn nhớ trong `localStorage` (bọc try/catch).
- **Thẻ Worker:** dòng đầu `<Name> · <tool> · <n> accounts` (giữ ô model/effort và nút Save hiện có). Dưới là danh sách tài khoản theo thứ tự, mỗi dòng gồm:
  - slug, email;
  - huy hiệu trạng thái (`In use` / `Next` / `Active, free` / `Usage limited · resets HH:MM` / `Sleeping` / `Re-login needed`);
  - ô chọn nhãn;
  - nút bật/tắt Active here;
  - nút ↑/↓;
  - lệnh ssh để đăng nhập lại.
- **Add Account (dialog):**
  - Chọn Worker, nhập slug.
  - Worker agy: thêm ô dán JSON hoặc chọn file.
  - Worker codex/claude: sau khi tạo, hiện link (`<a target=_blank rel=noopener>`, `href` chỉ nhận `https:`) và mã, poll `loginState` mỗi 2 giây. Khi `needs_code` thì hiện ô dán mã.
- **Import:** chọn file → gọi `dryRun` → hiện bảng *new / conflicts / rejected*. Mỗi mục trùng có ô tick ghi đè → bấm Confirm.
- **Export:** gọi `fetch` POST, rồi tải về bằng blob và `a.download`.
- Trên UI dùng chữ **Worker** (ví dụ `Worker Jacky`), không dùng "agent".

- [ ] **Step 1: Test web:**
  - Mọi key `tx()` đều có trong `STRINGS.en` (test cũ, phải vẫn xanh).
  - Có đủ 4 nút trong `#accounts-container`.
  - Thanh phiên không còn nút refresh energy.
  - Link đăng nhập chỉ nhận `https:` (kiểm tra chuỗi `url.indexOf('https://') === 0`).
  - Không dùng `innerHTML` với dữ liệu tài khoản.
- [ ] **Step 2–3:** FAIL → implement → PASS. Kiểm tra bằng demo local (port 8095) với snapshot giả có 3 tài khoản.
- [ ] **Step 4:** Commit `feat: Accounts UI with workers, tabs, add, import and export (P7 Task 5)`.

### Task 6: Hoàn tất

- [ ] Trên VM:
  - Chạy lại `isolation-setup.sh prep` để cài `btm-account` (cần anh Zon đồng ý, vì là thao tác sudo).
  - Chạy attack-check.
  - Test ×3.
- [ ] Review độc lập toàn nhánh. Sửa hoặc ghi nhận các vấn đề vào `team/reviews/P7-review-1.md`.
- [ ] Mở PR, merge. Ghi vào `team/log.md` và `team/board.md`. Deploy chờ anh Zon.
- [ ] Sau deploy, thử thật cùng anh Zon:
  - thêm `jacky/b` bằng JSON;
  - export ra file rồi import lại (dry-run);
  - tắt rồi bật Active here.
