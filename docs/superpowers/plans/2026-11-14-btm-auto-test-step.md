# BTM – Bước kiểm thử tự động do BTM chạy (thay cho "cấp full quyền") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Trạng thái:** để anh Zon review, **chưa làm**. Có 2 quyết định cần anh chọn (cuối file).
>
> **Cách chạy:** như các plan trước: Cheki làm từng task trên nhánh riêng, test VM ×3, tự merge. Deploy hỏi anh, chỉ deploy khi không có phiên chạy.

**Goal:** Sau mỗi lượt Dev qua gate, **BTM tự chạy kiểm thử** trong khu của worker (test, bật server, mở trang bằng trình duyệt không giao diện, ghi lỗi console, chụp màn hình) rồi đưa bằng chứng cho QC. QC không còn phải nhờ anh "chơi thử giúp", và agent **không cần thêm quyền**.

**Architecture:** Thêm module `src/autotest/` chạy dưới user worker của Dev qua `wrapForWorker` (như lệnh gate hiện nay), có hạn giờ và luôn `workerKillAll` khi xong. Kết quả là một file báo cáo do BTM viết (`team/reports/<ID>-auto.md`) cộng ảnh chụp màn hình, nạp vào lượt QC như ảnh Team note.

**Tech Stack:** như cũ. Trình duyệt: Chromium headless trên VM (cần anh duyệt cài đặt, xem Quyết định 1).

## Vì sao không cấp full quyền cho agent

- Home của mỗi worker có **token đăng nhập** của account đó. Agent full quyền mà bị lừa bởi nội dung lạ (prompt injection từ code, issue, trang web) có thể gửi token ra ngoài hoặc tự push.
- Quy định hiện tại cấm `--dangerously-skip-permissions`, `bypassPermissions`, `--dangerously-bypass-approvals-and-sandbox`. Plan này giữ nguyên quy định đó.
- Lỗi `listen EPERM :3000` của Marry đến từ **sandbox của CLI agent**, không phải từ user worker. BTM chạy lệnh dưới user worker nhưng **ngoài** sandbox của CLI, nên mở được cổng localhost mà không cần nới quyền cho agent (Task 1 kiểm chứng điều này trước).

## Global Constraints

- Mọi lệnh kiểm thử chạy **dưới user worker của Dev của ticket**, trong workspace của worker, qua `btm-worker-exec`. Không bao giờ chạy code của agent dưới user `agent` hay root.
- Mỗi bước có hạn giờ: test 5 phút, bật server 30 giây, trình duyệt 60 giây. Hết giờ thì `workerKillAll` và ghi `timeout` vào báo cáo.
- Chỉ nghe `127.0.0.1`. Không gọi ra mạng ngoài.
- Báo cáo `team/reports/<ID>-auto.md` do **BTM** viết. Agent sửa file này thì gate báo `ticket_tampered`-kiểu (`auto_report_tampered`).
- Cấu hình kiểm thử theo project nằm trong `team/project.yaml` (agent không sửa được, gate đã chặn):
  ```yaml
  autotest:
    test: "npm test"
    start: "npm start"
    url: "http://127.0.0.1:3000/"
    keys: ["ArrowLeft", "ArrowRight", "Space"]   # tuỳ chọn: phím bấm thử
  ```
  Không có khối `autotest` thì bỏ qua bước này (project cũ chạy như trước).
- Chạy tuần tự (`max_parallel_agents: 1`), nên một cổng cố định mỗi project là đủ; trước khi bật server, kiểm cổng còn trống, bận thì báo `port_busy` chứ không giết tiến trình lạ.

## Review Focus

1. **Server agent viết treo hoặc không tắt** → test: server giả không bao giờ trả lời → `timeout`, tiến trình bị giết, lượt sau chạy bình thường (Task 2).
2. **Trang lặp vô hạn / ăn hết RAM** → trình duyệt có hạn giờ 60 s và giới hạn bộ nhớ; test bằng trang `while(true){}` (Task 3).
3. **Cổng đã có người dùng** → báo `port_busy`, không giết tiến trình của người khác (Task 2).
4. **Agent sửa `team/reports/<ID>-auto.md` hoặc `team/project.yaml`** để làm đẹp kết quả → gate bắt (Task 4).
5. **Project không có `autotest`** → phiên chạy y như hôm nay, không lỗi (Task 4).

---

### Task 1: Kiểm chứng trên VM (spike, không đổi code BTM)

- [ ] Dưới user worker (`btm-worker-exec`), chạy một server Node nhỏ nghe `127.0.0.1:0` và `curl` vào được → ghi kết quả.
- [ ] Chạy `npm test` của GT dưới user worker trong workspace → ghi thời gian.
- [ ] Ghi kết luận vào cuối plan này: cổng mở được không, cần đổi gì ở `btm-worker-exec`.

### Task 2: Test + bật server (`src/autotest/smoke.ts`)

**Interfaces:** `runSmoke(cfg, agentId, checkout, spec: AutotestSpec): Promise<SmokeResult>`; `SmokeResult = { test: StepResult; start: StepResult; http: { status: number | null; assets: Array<{ path: string; status: number }> } }`; `StepResult = { ok: boolean; ms: number; tail: string; reason?: 'timeout' | 'exit' | 'port_busy' }`.

- [ ] Test trước: server giả trả 200 → `http.status === 200`; server giả treo → `start.reason === 'timeout'` và không còn tiến trình; cổng bận → `port_busy`.
- [ ] Code: chạy `spec.test`, rồi `spec.start` ở nền, đợi URL trả lời (thử mỗi 500 ms, tối đa 30 s), tải trang và các file `<script src>`/`<link href>` cùng gốc, rồi `workerKillAll`.

### Task 3: Mở trang bằng trình duyệt (`src/autotest/browser.ts`)

**Interfaces:** `runBrowser(cfg, agentId, url: string, keys: string[]): Promise<BrowserResult>`; `BrowserResult = { ok: boolean; consoleErrors: string[]; pageErrors: string[]; screenshot: string | null; reason?: 'timeout' | 'no_browser' }`.

- [ ] Test: trang có `console.error('x')` → `consoleErrors` có `x`; trang `throw` → `pageErrors`; trang lặp vô hạn → `timeout`; VM chưa có trình duyệt → `no_browser`, phiên vẫn chạy tiếp.
- [ ] Code: chạy Chromium headless dưới user worker, mở URL, bấm thử `keys`, đợi 3 s, chụp màn hình vào kho ảnh (theo plan attachments; tạm thời `.git/btm-answers/`), thu lỗi console. Lỗi cắt 20 dòng, mỗi dòng 300 ký tự (output không tin cậy).

### Task 4: Nối vào phiên + báo cáo

- [ ] Test (session): ticket có `autotest`, smoke và browser ok → có `team/reports/<ID>-auto.md`, QC nhận ảnh chụp qua `images`; smoke fail → xử lý theo Quyết định 2; project không có `autotest` → luồng cũ không đổi; agent sửa file `-auto.md` → `auto_report_tampered`.
- [ ] Code: gọi sau `runGate` thành công, trước lượt QC; ghi báo cáo (test: ok/fail + đuôi log; HTTP: mã trả về; trình duyệt: lỗi console, ảnh).

### Task 5: Prompt QC dùng bằng chứng

- [ ] Test: prompt QC có dòng "Đọc team/reports/<ID>-auto.md và ảnh chụp; không hỏi anh chơi thử nếu kiểm thử tự động đã chạy".
- [ ] Code: thêm dòng đó vào `qcTicketPrompt` khi có báo cáo auto.

### Task 6: Dashboard

- [ ] Bảng ticket: cột Tags thêm nhãn `Auto ✓` / `Auto ✗`; bấm vào xem báo cáo và ảnh (textContent, ảnh qua route đã kiểm magic bytes).

---

## Quyết định cần anh Zon chọn

1. **Cài trình duyệt lên VM** (một lần, cần anh duyệt vì tải về khoảng 150–200 MB):
   - **(Đề xuất)** `apt install chromium`: gói của Ubuntu, tự cập nhật bảo mật theo hệ thống. BTM gọi bằng `--headless` qua một script nhỏ dùng Chrome DevTools Protocol (không thêm dependency npm).
   - Hoặc Playwright (`playwright-core` + Chromium của nó trong `/opt`): code gọn hơn nhưng thêm dependency và phải tự cập nhật trình duyệt.
2. **Khi kiểm thử tự động fail:**
   - **(Đề xuất)** trả ticket về Dev như gate fail (tính một vòng sửa), kèm lỗi làm ghi chú sửa. QC không tốn lượt.
   - Hoặc vẫn chuyển QC, để QC quyết định.
