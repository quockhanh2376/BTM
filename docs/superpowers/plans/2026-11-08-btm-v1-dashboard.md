# BTM v1.0 – Kế hoạch 2: Dashboard & service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy ở dự án này:** Cheki giao từng task cho **Victor** (agy) qua `btm-task`, **Qeen** (codex read-only) review; Victor/Qeen không commit; Cheki kiểm tra, commit, push. Nhánh `plan2-dashboard`.

**Goal:** Anh Zon mở `http://localhost:8080` (qua `ssh -L`) thấy ai đang giữ lượt, thẻ 3 ghế, bảng task, nhật ký, và điều khiển được: mở phiên, duyệt thẻ, gửi lệnh, Dừng khẩn cấp, đổi sáng/tối. BTM chạy nền bằng systemd.

**Architecture:** Một process `btm serve` (systemd, user `agent`) vừa phục vụ web vừa chạy phiên trong cùng process (`SessionHost` giữ `AbortController` → Dừng khẩn cấp). Trạng thái dashboard = snapshot dựng từ SQLite + đuôi log lượt đang chạy; SSE đẩy snapshot khi nó đổi (poll DB 1 s, nên phiên chạy từ CLI cũng hiện). Web là **một file HTML + JS thuần**, không build.

**Tech Stack:** `node:http` (không thêm Fastify), SSE thuần, HTML/CSS/JS thuần, vitest; dùng lại toàn bộ Kế hoạch 1.

**Spec:** `docs/spec.md` §5, §6.2–6.3, §9, §14 + mockup dashboard (bố cục: thanh phiên → tiến độ mục tiêu → 3 thẻ ghế → bảng task 5 cột + nhật ký PM → khung lệnh).

**Ngoài phạm vi (Kế hoạch 3):** đọc hạn mức/Energy, đèn đăng nhập, trang Tài khoản, đổi ghế trên dashboard. Thẻ ghế hiện `Energy: —`, `Đăng nhập: —`.

**Lệch spec có chủ đích (Ruling):** `node:http` thay Fastify và HTML thuần thay React/Vite — dashboard nhỏ, không bước build, Victor không cài được package trong sandbox; đổi sau chỉ đụng `src/server/` và `web/`.

## Global Constraints

- Server chỉ `listen(port, '127.0.0.1')`; port = `host.dashboard.port`.
- Mọi `POST` phải có header `x-btm: 1`, `content-type: application/json`, body ≤ 16 KB, và `Origin` (nếu có) đúng `http://localhost:<port>` hoặc `http://127.0.0.1:<port>`; sai → 403/400, không làm gì.
- Không bao giờ có hai phiên cùng lúc: `SessionHost` dùng chung khóa `<data_dir>/btm.lock` với CLI (Kế hoạch 1).
- Dashboard không tự mở phiên, không hẹn giờ: chỉ chạy khi anh bấm (spec §9.1).
- Không gửi nội dung file ngoài project active; đuôi log tối đa 200 ký tự/dòng, bỏ mã ANSI.
- Giao diện tiếng Việt, theo mockup; nút thật `<button>`, ô nhập có `<label>`; tương phản ≥ 4.5:1 ở cả hai theme.
- Toàn bộ test: `npx vitest run`; `npx tsc --noEmit` sạch.

## Review Focus

1. **Trang web lạ trong trình duyệt anh gửi POST tới `localhost:8080`** (CSRF) → 403, không mở phiên/không gửi lệnh. (Task 4)
2. **Bấm "Mở phiên" khi `btm run` đang chạy từ terminal** → báo "đang có phiên", không chạy chồng. (Task 5)
3. **Dừng khẩn cấp giữa lượt Dev** → agent chết, lượt `error`, phiên `stopped`, hàng đợi xóa, nút "Mở phiên" dùng được lại. (Task 5)
4. **Log lượt chứa ANSI/dòng rất dài/file chưa tồn tại** → snapshot không lỗi, dòng cuối sạch ≤ 200 ký tự. (Task 3)
5. **Trình duyệt mất kết nối SSE (tắt tunnel)** → trang hiện "mất kết nối", tự nối lại, không treo. (Task 6)

---

## File Structure

```
src/store/db.ts          + turns.log_file, task_states, queue
src/core/session.ts      + ghi task_states, truyền log file theo turnId
src/runner/run.ts        Runner nhận logFile do session cấp
src/server/snapshot.ts   dựng snapshot JSON
src/server/host.ts       SessionHost: khóa, start/approve/stop, hàng đợi lệnh
src/server/http.ts       node:http: static, /api/*, SSE, guard
web/index.html           dashboard (HTML+CSS+JS thuần, theme sáng/tối)
src/cli.ts               + lệnh `btm serve`
deploy/btm.service       systemd unit
tests/…                  snapshot, host, http, web
```

---

### Task 1: Store – log, trạng thái task, hàng đợi

**Files:** Modify `src/store/db.ts`, `tests/store.test.ts`

**Interfaces — Produces:**
```ts
export type BoardState = 'pending' | 'in_dev' | 'awaiting_qc' | 'passed' | 'returned' | 'failed' | 'blocked';
export interface QueueItem { id: number; to: Seat; text: string; status: 'queued' | 'running' | 'done' | 'cancelled'; created_at: string }
// thêm vào Store:
setTurnLog(turnId: number, file: string): void;
setTaskState(sessionId: number, taskId: string, state: BoardState, fixRounds: number): void; // upsert
listTaskStates(sessionId: number): { task_id: string; state: BoardState; fix_rounds: number; updated_at: string }[];
listTurns(sessionId: number): { id: number; seat: Seat; agent: string; task_id: string | null; started_at: string; ended_at: string | null; result: string | null; error: string | null; log_file: string | null }[];
listHandoffFailures(sessionId: number): { task_id: string; reason: string; at: string }[];
enqueue(to: Seat, text: string): number;
nextQueued(): QueueItem | null;
setQueueStatus(id: number, s: QueueItem['status']): void;
cancelQueued(): number;            // số mục bị hủy
listQueue(limit: number): QueueItem[];
getSession(id: number): { id: number; goals: string[]; status: string; project: string | null; started_at: string; ended_at: string | null } | null;
```
Migration như Kế hoạch 1: thiếu cột/bảng thì `ALTER`/`CREATE IF NOT EXISTS` khi `openStore` (DB thật `/var/lib/btm/btm.db` đã có dữ liệu).

- [ ] **Step 1: Test**: DB cũ (tạo bằng schema Kế hoạch 1, không có cột/bảng mới) mở được và dùng được hàm mới; `setTaskState` gọi 2 lần cùng task → 1 dòng, state mới; `cancelQueued` chỉ hủy `queued`, không đụng `running`; `nextQueued` trả mục cũ nhất.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: store for dashboard".

### Task 2: Session ghi trạng thái bảng + log theo lượt

**Files:** Modify `src/core/session.ts`, `src/runner/run.ts`, `tests/session.test.ts`, `tests/run.test.ts`

**Interfaces:**
- `Runner = (seat, agentId, prompt, cwd, logFile: string) => Promise<TurnOutput>` (thêm tham số cuối; `makeRunner(cfg)` không còn nhận `logDir`).
- `SessionDeps` thêm `logDir: string` và `signal?: AbortSignal` (truyền xuống `runProcess`, đã có từ Kế hoạch 1).
- Mỗi lượt: `turnId = startTurn(...)`; `logFile = join(logDir, \`turn-${turnId}.log\`)`; `setTurnLog(turnId, logFile)` **trước** khi gọi runner.
- `setTaskState`: thẻ PM vừa tạo → `pending`; trước lượt Dev → `in_dev`; gate đạt → `awaiting_qc`; QC pass → `passed`; gate/QC rớt còn vòng → `returned` (fix_rounds tăng); hết vòng → `failed`; BLOCKED → `blocked`.

- [ ] **Step 1: Test** (runner giả): happy path ghi đúng chuỗi `pending → in_dev → awaiting_qc → passed`; QC rớt một lần → có `returned` với `fix_rounds: 1` rồi `passed`; mỗi lượt có `log_file` = `<logDir>/turn-<id>.log` trước khi runner được gọi (runner giả đọc `listTurns` thấy đã có).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: session board states + per-turn logs".

### Task 3: Snapshot

**Files:** Create `src/server/snapshot.ts`, `tests/snapshot.test.ts`

**Interfaces — Produces:**
```ts
export interface SeatCard { seat: Seat; agent: string; tool: Tool; status: 'running' | 'waiting' | 'idle';
  taskId: string | null; since: string | null; turns: number; lastLine: string; energy: '—'; login: '—' }
export interface Snapshot {
  project: string | null;
  session: { id: number; status: string; goals: string[]; turnsUsed: number; maxTurns: number } | null;
  holder: Seat | null;                       // ghế có lượt chưa ended_at
  seats: SeatCard[];                         // luôn đủ pm, dev, qc theo cfg.seats
  tasks: { id: string; goal: string; state: BoardState; fixRounds: number }[];
  log: { at: string; who: string; text: string }[];   // mới nhất trước, tối đa 50
  queue: QueueItem[];
}
export function lastLogLine(file: string | null): string;   // không throw
export function buildSnapshot(store: Store, cfg: Config): Snapshot;
```
`goal` của task đọc từ `team/tasks/<id>.md` qua `loadTaskCards` của project active (lỗi → `goal: ''`). `log` gộp: lượt bắt đầu/kết thúc (`"jacky bắt đầu T-001"`, `"jenny: ok"`), `handoff_failures` (`"gate: out_of_scope:x"`), trạng thái phiên. `status` của ghế: `running` nếu là holder, `waiting` nếu phiên đang chạy mà ghế khác giữ lượt, còn lại `idle`.

- [ ] **Step 1: Test**: `lastLogLine` với file có `\x1b[32mOK\x1b[0m\n\n` → `OK`; dòng 1 000 ký tự → 200 ký tự; file không tồn tại/`null` → `''`. `buildSnapshot` trên store `:memory:` có 1 phiên, lượt dev chưa kết thúc → `holder==='dev'`, card dev `running`, pm `waiting`; không có project active → `project:null`, `session:null`, 3 card `idle`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: dashboard snapshot".

### Task 4: HTTP server + guard + SSE

**Files:** Create `src/server/http.ts`, `tests/http.test.ts`

**Interfaces — Produces:**
```ts
export interface HostApi { start(goals: string[]): Promise<{ ok: boolean; error?: string }>; approve(): Promise<{ ok: boolean; error?: string }>;
  stop(): { ok: boolean }; command(to: Seat, text: string): { ok: boolean; id?: number; error?: string } }
export function createServer(o: { cfg: Config; store: Store; host: HostApi; webFile: string; pollMs?: number }): import('node:http').Server;
```
Routes: `GET /` → `web/index.html` (`text/html; charset=utf-8`, header `content-security-policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`); `GET /api/state` → `buildSnapshot`; `GET /api/events` → SSE (`event: state`, gửi ngay khi kết nối, sau đó chỉ khi JSON đổi; poll `pollMs` mặc định 1000; `: ping` mỗi 15 s; dọn interval khi client đóng); `POST /api/session {goals: string[]}`, `POST /api/approve {}`, `POST /api/stop {}`, `POST /api/command {to: 'pm'|'dev'|'qc', text}` → gọi `host`. Validate bằng zod; sai → 400 `{error}`. Route khác → 404.

- [ ] **Step 1: Test** (server thật trên port 0, `fetch`, host giả ghi lại lời gọi):
  - POST thiếu `x-btm` → 403, host không được gọi; `Origin: https://evil.example` → 403; body 20 KB → 413; `goals: []` hoặc 4 goal (> `max_goals`) → 400.
  - POST hợp lệ `/api/session` → 200, host.start nhận đúng goals.
  - `GET /api/events` nhận ngay một `event: state`; đổi store → nhận event mới; dữ liệu không đổi → không gửi lại.
  - `GET /` có header CSP và nội dung `web/index.html`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: dashboard http server".

### Task 5: SessionHost

**Files:** Create `src/server/host.ts`, `tests/host.test.ts`; Modify `src/cli.ts` (tách hàm khóa `acquireLock(dataDir): (() => void) | null` dùng chung, nếu chưa tách)

**Interfaces — Produces:** `export function createHost(d: { cfg: Config; store: Store; runner: Runner; logDir: string; dataDir: string; env: NodeJS.ProcessEnv }): HostApi & { busy(): boolean }`

Luật:
- `start(goals)`: không lấy được khóa → `{ok:false,error:'Đang có phiên chạy'}`. Lấy được → chạy `runSession` **không chờ** (trả `{ok:true}` ngay), giữ `AbortController`; xong (mọi kết quả) → nhả khóa, rồi chạy hàng đợi.
- `approve()`: như `btm run --approved` (resume phiên `awaiting_approval` mới nhất của project active) cùng luật khóa.
- `stop()`: `abort()` lượt đang chạy, `cancelQueued()`, phiên → `stopped`; idle thì vẫn `{ok:true}`.
- `command(to, text)`: `text` 1–2 000 ký tự. `to='pm'` → `start([text])` (lệnh cho PM = mở phiên với mục tiêu đó). `to='dev'|'qc'` → `enqueue`; khi rảnh (không phiên, không lượt) thì chạy **một lượt trực tiếp**: dev → runner với `devPrompt` dạng tự do (thẻ ảo id `CMD-<id>`, scope cả repo trừ `.git`) rồi `commitAll` với message `cmd <id>: <60 ký tự đầu>`; qc → runner read-only, kết quả (lastMessage) ghi vào log của lượt. Lượt trực tiếp vẫn `startTurn/endTurn`, vẫn tính khóa.

- [ ] **Step 1: Test** (runner giả có độ trễ điều khiển được): start hai lần liền → lần 2 `error`; giữ khóa bằng file lock của process khác (pid sống) → start bị từ chối; `stop()` giữa lượt → runner nhận abort, phiên `stopped`, khóa được nhả, `start` sau đó chạy được; `command('dev', …)` khi đang có phiên → `queued`, chạy sau khi phiên xong; `stop()` hủy mục `queued`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: session host".

### Task 6: Giao diện web

**Files:** Create `web/index.html`, `tests/web.test.ts`

Một file: `<style>` + `<script>` inline, không thư viện, không tải gì từ mạng. Bố cục theo mockup, từ trên xuống:
1. **Thanh phiên:** "Bot Task Manager", project active, `Phiên #id · trạng thái`, `Đã dùng x/y lượt`, ô **Đang giữ lượt: <agent>** (chấm nhấp nháy khi có holder), nút **Dừng khẩn cấp** (đỏ, `confirm()` trước khi gửi), nút **Duyệt thẻ** (chỉ hiện khi `awaiting_approval`), nút đổi theme dạng `<button aria-label="Chuyển sáng/tối">` (icon SVG, không emoji).
2. **Mục tiêu phiên:** danh sách goals.
3. **3 thẻ ghế** (Elon-PM, Jacky-Dev, Jenny-QC): tên + vai + công cụ, nhãn trạng thái (Đang làm / Chờ / Rảnh), task, bắt đầu, số lượt, dòng output cuối (font mono), `Energy: —`, `Đăng nhập: —`. Thẻ đang giữ lượt viền nhấn.
4. **Bảng task 5 cột:** Chờ (`pending`), Đang làm (`in_dev`), Chờ test (`awaiting_qc`), Đạt (`passed`), Trả về (`returned|failed|blocked`, ghi số vòng sửa) + **Nhật ký** bên cạnh (xếp dọc khi màn hẹp).
5. **Khung lệnh:** chọn người nhận (PM mặc định / Dev / QC, nút radio), `<textarea>` có `<label>`, nút **Gửi lệnh**; ghi chú "Lệnh cho PM = mở phiên với mục tiêu này; lệnh cho Dev/QC xếp hàng sau lượt đang chạy"; danh sách hàng đợi.

Theme: biến CSS trên `:root` cho sáng, `[data-theme=dark]` cho tối; mặc định theo `prefers-color-scheme`; bấm nút → đổi và lưu `localStorage['btm-theme']` (bọc try/catch). Dữ liệu: `EventSource('/api/events')`; `onerror` → hiện dải "Mất kết nối, đang thử lại…" (EventSource tự nối lại), có event mới thì ẩn. POST dùng `fetch` với header `x-btm: 1` + `content-type: application/json`; lỗi trả về hiện ngay dưới nút. Render bằng `textContent`/`createElement`, **không** `innerHTML` với dữ liệu (tên task, log có thể chứa `<`). Rộng 375 px không cuộn ngang.

- [ ] **Step 1: Test** (đọc file như text): có `id` cho `theme-toggle`, `stop-btn`, `approve-btn`, `cmd-text` + `<label for="cmd-text">`, `conn-banner`; có `prefers-color-scheme` và `localStorage`; có `'x-btm'`; không có chuỗi `innerHTML` và không có `http://`/`https://` ngoài ví dụ trong comment.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: dashboard web".
- [ ] **Step 6 (Cheki):** mở qua tunnel trong trình duyệt, kiểm tra cả hai theme ở 1280 px và 375 px, và trạng thái mất kết nối (tắt server). Lệch so với mô tả → task sửa.

### Task 7: `btm serve` + systemd + demo thật

**Files:** Modify `src/cli.ts`, `tests/init.test.ts` (hoặc `tests/cli.test.ts`); Create `deploy/btm.service`

- `btm serve`: `checkForbiddenEnv` (vi phạm → exit 2), mở store, `createHost`, `createServer`, `listen(cfg.host.dashboard.port, cfg.host.dashboard.bind)`; in `BTM dashboard: http://127.0.0.1:<port>`; SIGINT/SIGTERM → `host.stop()`, đóng server, đóng store, exit 0.
- `deploy/btm.service`:
  ```ini
  [Unit]
  Description=BTM dashboard
  After=network.target
  [Service]
  User=agent
  WorkingDirectory=/srv/agent-projects/btm
  Environment=PATH=/home/agent/.local/bin:/home/agent/.npm-global/bin:/usr/bin:/bin
  ExecStart=/usr/bin/npx tsx src/cli.ts serve
  KillMode=control-group
  Restart=on-failure
  UMask=0002
  [Install]
  WantedBy=multi-user.target
  ```

- [ ] **Step 1: Test** `main(['serve'], env có OPENAI_API_KEY)` → 2; `main(['serve'])` với port 0 trả server lắng nghe trên `127.0.0.1` (tách `serve()` trả `Server` để test, đóng sau test).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit "feat: btm serve + systemd unit".
- [ ] **Step 6 (Cheki, cần sudo):** `sudo cp deploy/btm.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now btm`; tunnel `ssh -N -L 8080:localhost:8080 admzon@100.96.250.103` từ Windows; mở dashboard, gõ mục tiêu cho PM "Go to the Moon", Duyệt thẻ, xem Jacky/Jenny chạy, thử Dừng khẩn cấp một lần; `systemctl stop btm` không để lại process agent (`pgrep -u agent -f agy` chỉ còn phiên tay của anh nếu có).

---

## Kế hoạch tiếp theo

- **Kế hoạch 3 – Energy, Tài khoản, plugin:** đọc hạn mức (agy `/quota`, Claude, Codex – chỉ đọc) điền `energy` ở thẻ ghế, đèn đăng nhập (`login`), trang Tài khoản, đổi ghế trên dashboard + biên bản bàn giao, `openspec init`.
