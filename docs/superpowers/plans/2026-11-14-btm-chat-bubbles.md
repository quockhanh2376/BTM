# BTM – Bong bóng thoại của agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy:** anh Zon duyệt thiết kế 2026-11-14 ("Duyệt, làm luôn"), Cheki tự làm (Native) trên nhánh `chat-bubbles`, test VM ×3, tự merge. Deploy hỏi anh.

**Goal:** Agent và anh Zon nói chuyện bằng bong bóng thoại trên avatar khi giao việc, xong việc, hỏi đáp, hỏi tiến độ, lúc rảnh; có công tắc tắt.

**Architecture:** Chỉ sửa `web/index.html`. Phần thuần (tìm sự kiện từ hai snapshot, chọn câu) là hàm không đụng DOM để test bằng cách cắt chuỗi như các test web khác. Phần hiện bong bóng là một hàng đợi chạy bằng `setTimeout`, gọi từ `renderSnapshot`, không chặn gì.

**Tech Stack:** như cũ, không thêm dependency.

**Spec:** `docs/superpowers/specs/2026-11-14-agent-chat-bubbles-design.md`

## Global Constraints

- Không sửa backend, không POST gì thêm, không lưu thoại.
- Ghế có `status === 'running'` không nói, không có bong bóng.
- Chữ trong bong bóng: textContent; nội dung từ agent/anh cắt 80 ký tự.
- Kho câu `en` và `vi`, theo `LANG`; giờ theo `formatHHmm` (giờ VN).
- Kiểu bong bóng: `chatStyleOf(agentId)` = hash id % 6, cố định theo id.
- Công tắc `#chat-toggle` ở `.agents-tools`, nhớ bằng localStorage key `btm.chat` (try/catch), mặc định On.

## Review Focus

1. **Trang mở lần đầu / tải lại** → không phát sự kiện cũ (`chatEvents(null, snap)` trả `[]`).
2. **Snapshot tới dồn dập** (SSE 1–2 s) → cùng một sự kiện không phát hai lần (so trạng thái ticket/ghế/câu hỏi, không dựa vào log).
3. **Tên hiển thị đổi giữa chừng** → câu dùng `agentLabel` lúc phát; kiểu bong bóng không đổi.
4. **Tắt Chat** → hàng đợi bị xoá, bong bóng đang hiện và bong bóng chờ biến mất ngay.
5. **Ghế không có thẻ (audit ẩn) hoặc agent rỗng** → bỏ qua câu đó, không lỗi.

---

### Task 1: Hàm thuần + kho câu

**Interfaces (Produces):**
- `chatEvents(prev, next): ChatEvent[]` với `ChatEvent = { type: 'assign'|'to_qc'|'passed'|'returned'|'start'|'question'|'answered'|'error', seat?: string, from?: string, to?: string, ticket?: string, text?: string }` (`from`/`to` là seat).
- `pickChatLine(kind: string, vars: object, lang: string): string` — chọn ngẫu nhiên, tránh câu vừa dùng cho cùng `kind`, thay `{from} {to} {ticket} {time} {mins} {status}`.
- `chatStyleOf(agentId: string): number` (0..5).

Quy tắc sự kiện (so ticket theo `id` qua mọi goal; ghế theo `seat`; câu hỏi theo `id`):
- ticket `pending → in_dev` → `assign` (pm → dev). `in_dev → awaiting_qc` → `to_qc` (dev → qc). `→ passed` → `passed` (qc → dev). `→ returned` → `returned` (qc → dev).
- ghế từ không `running` sang `running` → `start` (seat).
- câu hỏi mới → `question` (seat của câu hỏi, text); câu hỏi biến mất → `answered`.
- dòng log mới (so độ dài/`at` đầu) có text bắt đầu `error|timeout` → `error` (seat suy từ who).

- [ ] Test `tests/web.test.ts` describe "Chat bubbles": `chatEvents(null, s)` = `[]`; ticket pending→in_dev cho `[{type:'assign', from:'pm', to:'dev', ticket:'GT-0005'}]`; gọi lại với cùng snapshot cho `[]`; ghế dev idle→running có `start`; câu hỏi mới có `question`; `pickChatLine('assign', {to:'John', ticket:'GT-1'}, 'vi')` chứa `John` và `GT-1`, gọi 2 lần liền không trùng khi kho ≥2 câu; `chatStyleOf('jenny') === chatStyleOf('jenny')` và trong 0..5.
- [ ] Code các hàm và `CHAT_LINES = { en: {...}, vi: {...} }` gồm các kind: `assign, assignAck, to_qc, toQcAck, passed, passedAck, returned, returnedAck, question, answered, answeredAck, error, ownerAck, checkAsk, checkGiver, checkFinn, checkReport, idleSelf, chit, chitAck`, mỗi kind 5–6 câu.

### Task 2: Hiện bong bóng + hàng đợi + công tắc

**Interfaces:** Consumes Task 1. Produces `chatSay(target: string, text: string, opts?: { waiting?: boolean })` (target = seat hoặc `'owner'`), `chatPlay(events, snap)`.

- [ ] Test: html có `id="chat-toggle"`, `localStorage.getItem('btm.chat')` trong try; hàm hiện bong bóng dùng textContent, không innerHTML; CSS có `.chat-bubble.style-0` … `style-5` và `@keyframes chat-blink`.
- [ ] Code: bong bóng absolute trên `.seat-title-wrap` (owner: `.user-chip`), hiện 4 s rồi mờ; đáp sau 1,5 s; một cuộc thoại một lúc (hàng đợi). `assign/to_qc/returned` → người giao nói câu, người nhận hiện bong bóng chờ tới khi có `start` của ghế đó thì đáp `*Ack` rồi ẩn. `question` → câu hỏi rồi bong bóng chờ tới `answered`. `start` của ghế đang chờ → xoá bong bóng chờ. Ghế đang running: không nói.
- [ ] Gọi `chatPlay(chatEvents(lastChatSnap, state), state)` trong `renderSnapshot`, lưu `lastChatSnap`.

### Task 3: Anh nói với team, hỏi tiến độ, chuyện phiếm

- [ ] Test: hàm `chatCheckIn(snap, now)` trả mảng `[{target, text}]`: có ghế dev running từ `since` → có câu của Finn chứa tên Marry/John và số phút; ghế running không có trong target. `chatTargetsFor(to, snap)` với `'team'` trả mọi ghế không running, với `'qc'` trả `['qc']` (rỗng nếu đang running).
- [ ] Code: Send ở Command → `chatSay('owner', text)` rồi các ghế trong `chatTargetsFor` đáp `ownerAck` lệch nhau 300 ms. Hẹn giờ ngẫu nhiên 5–8 phút khi có ghế running: anh hoặc Finn hỏi (`checkAsk`), người giao việc đáp `checkGiver` (giờ VN từ `since`), Finn đáp `checkFinn` rồi `checkReport` (dòng `agentStatus || lastLine`, cắt 80). Khoảng 10 phút một lần, ≥2 ghế rảnh: `chit` + `chitAck`.

### Task 4: Kiểm tra trên preview, PR

- [ ] Xem light + dark, bật/tắt Chat, giả sự kiện bằng snapshot giả qua proxy.
- [ ] VM ×3, PR, merge, `docs/i18n-strings.md` thêm `chat.toggle`.
