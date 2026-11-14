# Dòng thời gian ticket + khối lượng + bài học – kế hoạch

> Thực hiện: Native (Cheki làm trong phiên). Checkbox `- [ ]` để theo dõi.

**Goal:** truy vết từng ticket (sự kiện, lượt, log), tổng khối lượng, và bài học sau mỗi goal dùng cho lần lập kế hoạch sau.
**Architecture:** đọc dữ liệu sẵn có (`ticket_history`, `turns.task_id`); bài học chạy qua làn hỏi đáp chỉ đọc, lưu file markdown cạnh nhật ký goal.
**Spec:** docs/superpowers/specs/2026-11-14-ticket-trace-lessons-design.md

## Ràng buộc chung
- Output agent không tin cậy: web dùng textContent; bài học lọc ký tự điều khiển, ≤10 câu, ≤300 ký tự/câu.
- Log: không nhận đường dẫn từ request; file phải nằm trong `logDir`; lượt phải thuộc project đang mở; ~300 dòng cuối.
- File bài học giữ 30 dòng mới nhất; dán vào prompt PM tối đa 3.000 ký tự; anh sửa tối đa 20.000 ký tự.
- Lượt bài học lỗi không ảnh hưởng release/duyệt goal.

## Review Focus
1. Turn id không tồn tại / thuộc project khác / log_file null hoặc ngoài logDir → 404, không đọc file. (test Task 1)
2. Agent trả rác hoặc không có khối `{"lessons"}` → không ghi file, lượt ghi `rejected`. (test Task 3)
3. Ticket chưa có lượt nào (mới tạo) → events chỉ có đổi trạng thái, totals = 0. (test Task 1)
4. Chưa có file bài học → prompt PM không có mục bài học; GET /api/lessons trả chuỗi rỗng. (test Task 3)
5. Lượt đang chạy (ended_at null) → thời lượng tính tới hiện tại, không NaN. (test Task 1)

---

### Task 1: Trace API + log
**Files:** `src/store/db.ts`, `src/store/types.ts`, `src/server/trace.ts` (mới), `src/server/routes/tickets.ts`, `tests/trace.test.ts`
- Store: `ticketTurns(project, ticketId): TicketTurnRow[]` (`id, seat, agent, started_at, ended_at, result, error, log_file`; join sessions.project) và `turnLogFile(project, turnId): string | null`.
- `buildTicketTrace(store, project, ticketId, now?) → { events: TraceEvent[], totals: { turns, agentMs, bySeat, fixRounds, returns } }`.
  `TraceEvent = { kind:'state', at, by, from, to, reason } | { kind:'turn', id, at, endedAt, seat, agent, result, error, ms, hasLog }`, xếp theo `at`.
- `readTurnLog(store, project, logDir, turnId, maxLines=300) → string | null`.
- Route `GET /api/tickets/:id/trace`, `GET /api/turns/:id/log` (text/plain; charset=utf-8).
- Test: trộn đúng thứ tự; totals (2 lượt dev 10′+5′, 1 qc 3′, 1 lần returned); lượt đang chạy; log ngoài logDir / project khác / không có → null; 300 dòng cuối.

### Task 2: Khối lượng theo agent + UI dòng thời gian
**Files:** `src/store/db.ts` (`goalTurns` thêm `agent`), `src/server/snapshot.ts` (`GoalTime.byAgent`), `src/knowledge/digest.ts` (dòng "theo agent"), `web/app/app.js` (`toggleTicketHistory` dùng /trace), `web/app/goals.js` (byAgent trên thẻ), `web/app/i18n.js`, `web/app/app.css`, tests snapshot/web.
- Hàng lịch sử: dòng tổng ở đầu (lượt, thời gian theo ghế, vòng sửa, lần trả về), rồi từng sự kiện; lượt có nút "Log" mở `<pre>` (textContent).

### Task 3: Bài học
**Files:** `src/knowledge/lessons.ts` (mới), `src/core/prompts.ts`, `src/server/ask-lane.ts`, `src/server/host.ts`, `src/core/goal/pm-planning.ts`, `src/server/routes/` (lessons), `src/server/search.ts`, web (ô Lessons), `tests/lessons.test.ts`.
- `parseLessons(text) → string[] | null` (khối JSON `{"lessons":[…]}` cuối cùng, zod, ≤10, cắt 300).
- `lessonsFile(dataDir, key)`, `sharedLessonsFile(dataDir)`; `appendLessons(file, tag, lessons, keep=30)`; `readLessons(file) → string`; `lessonsForPrompt(dataDir, key, max=3000) → string`.
- `lessonsPrompt(n, digest) → string` (chỉ đọc, trả JSON).
- Duyệt goal: sau `saveGoalDigest` → `store.enqueue('ask-lessons', 'G<n>')`. Làn hỏi đáp: `ask-lessons` → ghế pm, rồi các ghế khác, rồi agent `provider: zai`; ok → parse, ghi 2 file, lưu câu trả lời vào Meeting room; parse lỗi → endTurn 'rejected'.
- `pmTicketPrompt` opts `lessons?: string` → thêm "Bài học từ các goal trước (tham khảo): …".
- `GET /api/lessons` → `{ project, shared }`; `POST /api/lessons {scope:'project'|'shared', text}` (≤20.000).
- Search: thêm mục kind `lesson`.

### Task 4: Kiểm tra + PR
- `npx tsc --noEmit`, test cục bộ, VM ×3, grep bí mật, PR, merge.
