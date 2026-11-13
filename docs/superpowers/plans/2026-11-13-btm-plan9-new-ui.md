# BTM – Kế hoạch 9: Giao diện mới theo mẫu (sáng/tối) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy:** Cheki làm từng task trên nhánh `plan9-<task>`, xem trực quan ở proxy chỉ đọc (8091) cả sáng lẫn tối và ở bề rộng điện thoại, test VM ×3, rồi tự merge. Deploy hỏi anh Zon, và chỉ deploy khi không có phiên đang chạy. **Mỗi task là một PR**: giao diện đổi dần, lúc nào dashboard cũng dùng được.

**Goal:** Làm lại dashboard theo ảnh mẫu `docs/design/2026-11-13-dashboard-mockup.webp`, có cả chế độ sáng và tối. Mọi chức năng đang chạy tốt giữ nguyên hành vi, chỉ đổi cách trình bày. Thêm các nút/khối mẫu có mà BTM chưa có, khi có dữ liệu thật đứng sau.

**Architecture:** Vẫn là một trang `web/index.html` (HTML/CSS/JS thuần, không build, CSP `script-src 'self' 'unsafe-inline'`). Giữ nguyên lớp dữ liệu (`/api/state`, SSE, `tx()`, `postJson`) và các `id` mà JS/test đang dùng. Đổi bố cục thành sidebar + header + lưới thẻ. Phần mới cần dữ liệu thì thêm 2 API chỉ đọc: `/api/stats` (từ bảng `turns`/`tickets`) và `/api/system` (CPU/RAM/Disk/Net của VM). Biểu đồ vẽ bằng SVG tự viết, vì CSP không cho tải thư viện ngoài.

**Tech Stack:** như Kế hoạch 1–8. Không thêm dependency.

**Spec:** ảnh mẫu của anh Zon (2026-11-13) + bảng đối chiếu bên dưới.

## Global Constraints

- **Chức năng giữ nguyên:** mọi nút, API và luồng hiện có vẫn chạy y như cũ (Resume, Stop, Approve, Auto-approve, Command, Inbox, câu hỏi, Accounts, đổi model/effort, đổi ghế, avatar, đổi tên, đồng hồ bấm giờ, diff, Approve goal, Push lại). Không nút nào bị mất, chỉ đổi chỗ.
- Giữ các `id` mà JS và `tests/web.test.ts` đang dùng. Đổi `id` nào thì sửa test cùng PR và ghi lý do.
- Sáng/tối dùng biến màu ở `:root` và `[data-theme="dark"]` (cách hiện có). Không màu cứng trong từng phần tử. Nút đổi theme giữ ở header.
- Dữ liệu do agent viết (log, báo cáo, câu hỏi, tên job…) vẫn hiển thị bằng `textContent`. Không dùng `innerHTML` cho dữ liệu.
- Không tải gì từ ngoài (font, script, ảnh): CSP `default-src 'self'`. Font dùng font hệ thống.
- Chuỗi hiển thị qua `tx()` và ghi vào `docs/i18n-strings.md`.
- **Viền chạy (anh Zon 2026-11-13):** giữ đúng quy tắc hiện có cho thẻ ghế: `.seat-card.is-holder::before`, đốm sáng xanh nhạt `#9ec5ff` chạy quanh viền thẻ đang giữ lượt, vòng 2,8 s, luôn chạy kể cả reduced-motion, chỉ vẽ trên viền nhờ mask. **Thêm viền chạy cho thẻ Accounts** của Worker đang chạy lượt, bằng **màu khác** (đề xuất cam/hổ phách `#ffb86b`) và quay ngược chiều, để hai viền không lẫn nhau. Dùng chung `@property --glow-angle`, mỗi loại một biến màu (`--glow-seat`, `--glow-account`), có giá trị cho cả sáng và tối.
- Bề rộng 360 px dùng được: sidebar thu vào nút ☰, các lưới xếp một cột, không cuộn ngang.
- API mới: chỉ GET, chỉ đọc, `127.0.0.1`. Không đọc file ngoài DB và `/proc`.
- `npx vitest run` không tăng số fail; `npx tsc --noEmit` không thêm lỗi; VM ×3 xanh.

## Bảng đối chiếu: mẫu → BTM

| Khối trong mẫu | Dùng dữ liệu BTM nào | Ghi chú |
|---|---|---|
| Sidebar: Dashboard, Accounts, Tasks & Goals, Instances, Logs, Reports, Settings | Neo cuộn tới từng khối của trang | Reports/Settings xem "Anh cần chốt" 1 |
| Sidebar: System Status (CPU, RAM, Disk, Net, Healthy) | **Mới** `/api/system` (Node `os` + `/proc`) | "Healthy" = service chạy + DB mở được + không phiên lỗi |
| Header: tiêu đề, khung thời gian, ⟳, 🔔, ?, người dùng | ⟳ = tải lại state + Refresh energy; 🔔 = số việc chờ anh (câu hỏi + `needs_owner` + goal chờ duyệt + inbox mới); ? = mở `docs/` trên GitHub; người dùng = tên chủ (tĩnh) | Giữ thêm: chip Project/Session/Turns, Auto-approve, Approve tickets, Resume, Stop, đổi theme |
| 4 thẻ số: Total Accounts, Running Instances, Active Goals, Total Tasks | Số tài khoản; số ghế đang chạy/tổng ghế; goal chưa merge; tổng ticket | Mũi tên % = thay đổi so với 24 giờ trước, tính từ `/api/stats` |
| Command (ô soạn, ⤢, gửi) | Ô Command hiện có (Team/PM/Dev/QC, 📎, gửi) | ⤢ = mở ô soạn to (mới, chỉ UI). Radio lọc trong mẫu thay bằng radio người nhận hiện có |
| Instruction & Queue (Save Template, Clear, Run) | Khối "Session & queue" + **mẫu goal** (mới, lưu ở settings) | Save Template = lưu chữ đang soạn; Run = gửi mẫu cho PM; Clear = xoá ô soạn (không xoá hàng đợi) |
| Accounts (thẻ Worker: Active, ⋯, Server/IP/Proxy/Profile) | Tên + avatar, công cụ · user Linux, đèn đăng nhập, model/effort, Energy, tài khoản đang dùng | IP/Proxy không có ở BTM → thay bằng Tool, User, Model·Effort, Energy. ⋯ = Đổi tên, Đổi avatar, Login cmd, Export Worker. **Mũi tên ▸ trên từng thẻ** (anh Zon yêu cầu) |
| Accounts toolbar: Import, Export, Thao tác hàng loạt, Add Account | Import/Export/Add hiện có | Hàng loạt = Refresh energy tất cả, Đánh thức/Cho ngủ tài khoản đã chọn |
| Running Instances (thẻ ghế: Live/Idle, Stop/Start, Account, Tasks, Total, Success, Speed, Mode, Progress, Last log) | Thẻ ghế hiện có + **số liệu mới** từ `/api/stats`: Tasks = ticket đã làm, Total = số lượt, Success = lượt ok, Speed = phút/lượt trung bình, Mode = model·effort, Progress = Energy cửa sổ thấp nhất | Start ở ghế rảnh = Resume (chỉ hiện khi phiên dừng). Giữ đồng hồ, chọn agent ngồi ghế, avatar, ✎ |
| Task Statistics (cột Success/Failed theo giờ) | **Mới** `/api/stats`: lượt `ok` và lượt lỗi theo giờ | SVG tự vẽ |
| Instance Status (vòng Running/Idle/Error) | Ghế running / idle / ghế có lượt cuối lỗi | SVG |
| Success Rate (đường %) | Tỉ lệ lượt ok theo giờ | SVG |
| Goals (tiến độ N/M, Add Goal) | Danh sách goal hiện có (pipeline, tab ticket, Approve merge, link release) | Add Goal = chọn PM trong ô Command và focus vào đó |
| Logs (Realtime: Time, Level, Message, lọc, View Full Logs) | Log hiện có + mức (INFO/WARN/ERROR suy ra từ kết quả lượt) | View Full Logs = mở rộng khung, tải thêm |
| — (mẫu không có) | Câu hỏi chờ trả lời, Team inbox, Diff panel, Approve tickets | Giữ, đặt trong khung Goals / panel phụ |

## Mẫu tối thứ 2 (anh Zon 2026-11-13)

Anh gửi thêm một ảnh mẫu **chế độ tối** dựng trên dữ liệu thật của BTM (G1 GameTest, Finn/John/Marry/Bruno). Ảnh mẫu đầu vẫn là nguồn chính cho bố cục; mẫu tối này **bổ sung** những điểm dưới đây (ảnh chưa lưu vào repo: anh gửi qua chat, mô tả bằng chữ ở đây). Mẫu dùng chữ tiếng Việt, nhưng quyết định "100% tiếng Anh trước, VI sau" vẫn giữ: chữ VI trong mẫu là bản dịch đích cho `tx()` sau này.

| Khối trong mẫu tối | Khác so với hiện tại / mẫu đầu | Task |
|---|---|---|
| Thanh trên cùng: chip Project ▾, Session #14 (Needs owner), Turns 3/10, khoảng ngày ▾, Environment ▾, công tắc Auto refresh, 🔔, người dùng ▾, nút theme | Chip Project/Session/Turns lên thanh trên cùng; khoảng ngày = `range` của `/api/stats` | 5 (khoảng ngày), 7 (dời chip) |
| Tiêu đề trang có icon bot + dòng mô tả | Thêm icon + mô tả dưới "Dashboard" | 7 |
| **6 thẻ số** (thêm Success rate % và Error rate %, mỗi thẻ ô icon màu riêng, mũi tên ±) | Hiện có 4 thẻ; 2 thẻ mới lấy từ `/api/stats` (lượt ok / lượt lỗi, không tính aborted/usage_limit/no_usable_account) | 5 |
| Command: người nhận là **nút dạng viên thuốc** (Team/PM/Dev/QC/Audit) thay radio | Giữ `input[name="cmd-to"]` (JS/test dùng), chỉ đổi CSS thành segmented pills | 3 |
| Khối "AI task" (= Session & queue): chữ goal + chip trạng thái (Needs owner) + hàng đợi `#1 \| dev \| continue` + nút **▶ Run** | ▶ Run = Resume khi phiên dừng (gọi hàm Resume hiện có), ẩn khi đang chạy | 3 |
| Accounts: 4 thẻ Worker **gọn trên một hàng**: chấm trạng thái, "Tên · accounts: N", chip công cụ, CLI/Model + Effort, dòng lệnh login `ssh -t …`, OK + chip "In use" + email tài khoản đang dùng | Giữ ▸ từng thẻ, ⋯, viền cam khi đang chạy (Task 4 cũ) | 4 |
| Toolbar Accounts: Import, Export, Refresh energy, **Add Account ▾** (nút tách có mũi tên) | ▾ = menu: Add account, Import Worker | 4 |
| "Bot / Instance list · Running: 3 \| Total: 4", thu gọn ▸ | Thẻ ghế: tiêu đề "Tên-Ghế ✎", dòng công cụ · model, chip **Live/Paused/Idle**, nút ⏸ / ▶ / ■; hàng Task · Started · Turns · Agent ▾; khung "Last log"; thanh Energy 5h và Tuần có % và giờ reset | 5 |
| Hàng 4 biểu đồ: cột Task (Success/Running/Error theo ngày), vòng Instance (Running/Paused/Error), đường Success rate có nhãn giá trị cuối, **System performance** (CPU/RAM/Disk + mạng ↑↓) | System performance chuyển thành một thẻ ở hàng biểu đồ; sidebar giữ ô nhỏ "System healthy · Updated hh:mm:ss" | 5 |
| Goals: "Total: 1 goal \| In progress: 1", **pipeline ngang** Intake → Planning → Dev → Testing → Security audit → Release (bước hiện tại tô xanh), tab trạng thái có số (Pending 5, In dev 1, Awaiting QC 0, Passed 0, Returned 0), bảng ID / Title / Diff / type / size / Fix rounds / Updated | Pipeline và tab có sẵn, đổi trình bày; thêm bước Security audit + Release vào pipeline (đã có dữ liệu audit/release) | 6 |
| System log (Realtime): bảng Time / **Level** (badge INFO/WARN/ERROR) / **Source** (Tên-Ghế, tô màu theo ghế) / Message, "View full →" | Thêm cột Source (agent + ghế của lượt) bên cạnh Level đã lên kế hoạch | 6 |
| Sidebar: Dashboard, Accounts, Bots & Tasks ▾, Goals, Logs, Reports, Settings; khối **Quick actions** (New task, Import accounts, Export report, Refresh data); chân sidebar "System healthy" | Quick actions gọi hàm có sẵn (focus Command, Import, ⟳); Export report → "Coming soon" | 7 |

**Màu tối theo mẫu:** nền rất tối ánh xanh tím (`#0B1020`–`#0F1426`), thẻ `#121A2E` viền mảnh `#1E2A44`, nhấn xanh `#3B82F6`, thanh/biểu đồ xanh lá `#22C55E`, cảnh báo đỏ `#EF4444`, ô icon thẻ số mỗi màu một tông. Chỉ đổi giá trị biến ở khối `[data-theme="dark"]` và `prefers-color-scheme: dark`; chế độ sáng không đổi. Kiểm tương phản chữ ≥ 4.5:1 (test web hiện có).

**Đã làm rồi (Task 1–2, chip Live, ảnh trả lời):** giữ nguyên; mẫu tối chỉ chỉnh màu và vị trí, không bỏ chức năng nào.

## Review Focus

1. **Mất một nút đang dùng** khi dời bố cục → test liệt kê đủ `id` các nút hiện có (Resume, Stop, Approve, Auto-approve, gửi, 📎, Import, Export, Add Account, ▸, ✎, avatar, Approve merge, Push lại, theme). (mọi task)
2. **Chế độ tối có chữ không đọc được** (màu cứng) → chỉ dùng biến; kiểm bằng ảnh chụp cả hai chế độ ở mỗi task.
3. **Biểu đồ khi không có dữ liệu** (project mới, 0 lượt) → hiện "Chưa có dữ liệu", không lỗi chia cho 0. (Task 5)
4. **`/api/system` trên Windows/dev** (không có `/proc`) → trả các trường `null`, giao diện hiện "–". (Task 2)
5. **Màn hẹp 360 px** → sidebar thành ☰, lưới một cột, không cuộn ngang. (Task 1, kiểm lại ở Task 7)

---

### Task 1: Khung trang – biến màu sáng/tối, sidebar, header

**Files:** Modify `web/index.html`, `docs/i18n-strings.md`; test `tests/web.test.ts`.

- Bộ biến màu mới theo mẫu: nền xám rất nhạt / thẻ trắng / chữ xanh đen / nhấn xanh dương `#2563EB` (sáng); nền `#0F1115` / thẻ `#171A21` / nhấn `#3B82F6` (tối). Bo góc 12px, bóng nhẹ ở chế độ sáng.
- `<aside class="sidebar">`: logo "Bot Task Manager" + phiên bản (đọc từ `package.json` qua `/api/state.version`, **mới**, 1 dòng ở snapshot), các mục neo `#dashboard`, `#accounts`, `#goals`, `#instances`, `#logs`; ô System Status (để trống, Task 2 đổ dữ liệu); nút Collapse (lưu trạng thái vào `localStorage`, có try/catch).
- Header: tiêu đề + mô tả; chip Project/Session/Turns + ô người đang giữ lượt (giữ `id` cũ); ⟳; 🔔 kèm số; ?; Auto-approve; Approve tickets; Resume; Stop; đổi theme; tên người dùng.
- [ ] Test: còn đủ `id` cũ; có `class="sidebar"`; theme dùng biến (`[data-theme="dark"]` định nghĩa lại các biến mới); ≤ 900 px có nút ☰.
- [ ] Ảnh chụp sáng/tối/360 px. Commit, VM ×3, merge.

### Task 2: Thẻ số và System Status

**Files:** Create `src/server/system.ts`; Modify `src/server/http.ts`, `src/server/snapshot.ts`, `web/index.html`; tests `tests/system.test.ts`, `tests/http.test.ts`, `tests/web.test.ts`.

- `readSystem(now, deps = { os, readFile })`: `{ cpuPercent, ramPercent, diskPercent, netInBps, netOutBps, healthy }`. CPU từ 2 lần đọc `os.cpus()` cách nhau (giữ mẫu trước ở bộ nhớ); RAM từ `os.totalmem/freemem`; Disk từ `fs.statfsSync(data_dir)`; Net từ `/proc/net/dev` (hiệu giữa 2 lần gọi). Không có thì `null`.
- `GET /api/system` (chỉ đọc). Dashboard gọi mỗi 10 giây khi tab đang hiện.
- 4 thẻ số tính ở trình duyệt từ snapshot. Mũi tên % lấy từ `/api/stats` (Task 5); trước khi có thì ẩn.
- [ ] Test `readSystem` với `os` giả và `/proc/net/dev` giả; không có `/proc` → null; API trả JSON đúng khoá.

### Task 3: Command và Instruction & Queue

**Files:** Modify `src/server/http.ts`, `web/index.html`, `docs/i18n-strings.md`; tests `tests/http.test.ts`, `tests/web.test.ts`.

- Ô Command giữ nguyên chức năng, thêm nút ⤢ mở ô soạn to (dialog, Esc để đóng).
- Mẫu goal: `GET/POST /api/templates` lưu ở setting `goal_templates` (mảng `{ name, text }`, tối đa 20, mỗi text ≤ 4000 ký tự, lọc ký tự điều khiển). Save Template / chọn mẫu / Run (gửi cho PM qua `/api/command`) / Clear (xoá ô soạn).
- Khối Session & queue giữ dữ liệu cũ, đổi trình bày giống mẫu.
- [ ] Test API mẫu: giới hạn số lượng và độ dài, 409 khi đang có lượt chạy chỉ với Run; web: có ⤢ và 3 nút.

### Task 4: Accounts theo mẫu (mũi tên từng thẻ, menu ⋯, hàng loạt)

**Files:** Modify `web/index.html`, `docs/i18n-strings.md`; test `tests/web.test.ts`.

- Thẻ Worker: avatar + tên (✎), công cụ · user, đèn Active/Relogin, menu ⋯ (Đổi tên, Đổi avatar, Copy login cmd, Export Worker này). Bảng 4 dòng: Tool, Model · Effort (select hiện có), Energy (thanh), Tài khoản đang dùng.
- **Viền chạy trên thẻ Worker** đang chạy lượt (`.acc-card.is-running::before`), màu `--glow-account`, cùng lúc với viền xanh ở thẻ ghế (xem Global Constraints).
- **Mũi tên ▸/▾ trên từng thẻ**, mở danh sách tài khoản của Worker đó; tự thu gọn sau 3 phút (giữ hằng số hiện có). Nút ▸ chung trên toolbar vẫn giữ (mở/đóng tất cả).
- Toolbar: Import, Export, Thao tác hàng loạt (Refresh energy tất cả; Đánh thức / Cho ngủ các tài khoản được tick, gọi API hiện có), Add Account.
- [ ] Test: mỗi thẻ có nút mũi tên với `aria-expanded`/`aria-controls`; menu ⋯ gọi đúng hàm cũ (`renameAgent`, avatar, export); thẻ Worker đang chạy có class `is-running`, và CSS viền thẻ Worker dùng `--glow-account` khác `--glow-seat`.

### Task 5: `/api/stats`, thẻ ghế (Instances) và 3 biểu đồ

**Files:** Create `src/server/stats.ts`; Modify `src/store/db.ts` (1 truy vấn đọc), `src/server/http.ts`, `web/index.html`; tests `tests/stats.test.ts`, `tests/http.test.ts`, `tests/web.test.ts`.

- `buildStats(store, project, range: '24h' | '7d', now)`: theo giờ (24h) hoặc theo ngày (7d): `{ buckets: [{ at, ok, failed }], perAgent: { [agent]: { tickets, turns, ok, avgMinutes } }, delta: { tickets, goals, accounts } }`. Lượt không tính (aborted / usage_limit / no_usable_account) không vào failed.
- `GET /api/stats?range=24h|7d` (chỉ đọc, range lạ → 400).
- Thẻ ghế: thêm các dòng Tasks, Total, Success, Speed, Mode, Progress (thanh Energy) theo mẫu; nút Start ở ghế rảnh = Resume khi phiên đang dừng. Giữ đồng hồ, chọn agent, avatar, ✎, Stop.
- 3 biểu đồ SVG: cột ok/failed, vòng Running/Idle/Error, đường tỉ lệ ok. Có ô chọn khung thời gian (dùng chung với header). Không có dữ liệu → "No data yet".
- [ ] Test `buildStats` với DB `:memory:` (lượt ok/timeout/aborted ở các giờ khác nhau); API 400 với range lạ; web: SVG dựng bằng `createElementNS`, không `innerHTML`.

### Task 6: Goals và Logs theo mẫu

**Files:** Modify `web/index.html`, `src/server/snapshot.ts` (thêm `level` cho mỗi dòng log), `docs/i18n-strings.md`; tests `tests/snapshot.test.ts`, `tests/web.test.ts`.

- Goals: mỗi goal một dòng (biểu tượng trạng thái, tiêu đề, N/M, thanh tiến độ); bấm vào thì mở pipeline + tab ticket + Approve merge + link release như hiện tại. Nút Add Goal. Câu hỏi chờ trả lời và Team inbox đặt ngay trên danh sách goal.
- Logs: bảng Time / Level / Message; `level` = ERROR khi lượt lỗi (không phải aborted), WARN khi timeout/no_progress/usage_limit, còn lại INFO; lọc theo mức; View Full Logs mở rộng khung.
- [ ] Test: log có `level` đúng theo kết quả lượt; web: lọc mức, không `innerHTML`.

### Task 7: Hoàn thiện

- Kiểm cả trang ở sáng/tối, 1440 px / 1024 px / 768 px / 360 px; bàn phím (Tab đi qua đủ nút, focus thấy rõ); `prefers-reduced-motion`.
- So lại với Review Focus 1: không thiếu nút nào. Ảnh chụp trước/sau gửi anh Zon.

## Thứ tự
1 → 2 → 3 → 4 → 5 → 6 → 7. Task 1 đổi khung nên làm trước; Task 4 xong là có mũi tên trên từng thẻ Accounts.

## Anh đã chốt (2026-11-13)
1. **Reports và Settings:** hiện trên sidebar để anh thấy bố cục, **không code chức năng** (bấm vào chỉ hiện "Coming soon"). Không code các phần UI dư, ghi vào danh sách dưới đây để làm thành chức năng sau.
2. **IP / Proxy / Server** trên thẻ Accounts → thay bằng Tool, Model · Effort, Energy, tài khoản đang dùng.
3. **Ngôn ngữ:** 100% tiếng Anh trước, nhưng **phải có nút chuyển EN / VI** ở header. Chọn VI lúc này chỉ hiện "Tiếng Việt: coming soon" và giữ tiếng Anh; bản dịch làm sau qua bảng `tx()`.
4. **Progress trên thẻ ghế** = Energy còn lại.

## Phần UI dư: chỉ hiện, chưa có chức năng (làm thành tính năng sau)
| Phần | Hiện tại | Chức năng dự kiến sau này |
|---|---|---|
| Sidebar → Reports | Mục menu, bấm hiện "Coming soon" | Trang báo cáo: tổng hợp goal, audit, release theo thời gian |
| Sidebar → Settings | Mục menu, bấm hiện "Coming soon" | Xem config (chỉ đọc), sau đó sửa các mục an toàn qua dashboard |
| Nút ngôn ngữ VI | Nút có, chọn VI hiện "coming soon" | Bản dịch tiếng Việt cho toàn bộ `tx()` |
| Menu người dùng (tên + mũi tên ở góc phải) | Chỉ hiện tên chủ | Đổi tên hiển thị, đăng xuất khi dashboard có đăng nhập |
| Nút ? (help) | Mở thư mục `docs/` trên GitHub | Trang hướng dẫn trong dashboard |

| Chip Project ▾ (mẫu tối) | Hiện tên project, chưa đổi được | Chọn/đổi project ngay trên dashboard (xem tầm nhìn đa project) |
| Environment ▾ (Dev) (mẫu tối) | Hiện "Dev" cố định | Tách môi trường Dev/Staging/Prod cho từng project |
| Công tắc Auto refresh (mẫu tối) | Dashboard đã cập nhật trực tiếp qua SSE; công tắc chỉ hiện | Tạm dừng cập nhật màn hình khi cần đọc kỹ |
| Nút ⏸ / ▶ trên từng thẻ ghế (mẫu tối) | ▶ = Resume khi phiên dừng; ⏸ chỉ hiện | Tạm dừng riêng một ghế mà không dừng cả phiên |
| Quick action "Export report" (mẫu tối) | Bấm hiện "Coming soon" | Xuất báo cáo (gắn với trang Reports) |

Task nào gặp thêm phần dư thì bổ sung vào bảng này.
