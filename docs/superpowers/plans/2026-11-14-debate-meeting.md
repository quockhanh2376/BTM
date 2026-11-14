# Họp tranh luận – kế hoạch (bước 1)

> Thực hiện: Native (Cheki làm trong phiên). Spec: docs/superpowers/specs/2026-11-14-debate-meeting-design.md

## Ràng buộc
- Lượt họp chạy runner ghế `qc` (chỉ đọc) + `noImport`; không dùng agent đang có lượt mở.
- Output agent không tin cậy: zod, cắt độ dài, web dùng textContent.
- Core tải GitHub: chỉ host github.com / api.github.com / raw.githubusercontent.com, timeout 10 s, ≤ 20.000 ký tự; lỗi → họp vẫn chạy, ghi chú "không tải được".
- Meeting lưu trong settings `meetings:<project>` (giữ 10 cuộc gần nhất), tài liệu ở file riêng.

## Review Focus
1. Agent trả rác / không có JSON → lượt ghi `skipped: invalid`, họp đi tiếp.
2. Stop giữa lượt → lượt bị huỷ không ghi ý; Resume chạy lại đúng người đó.
3. Dẫn chứng `file` trỏ ra ngoài repo (`../`, đường dẫn tuyệt đối) → ⚠, không đọc file.
4. Một agent ngồi 2 ghế → nói một lần; không ai nói được → họp kết thúc `done` với ghi chú.
5. Khởi động lại BTM giữa cuộc họp → họp `running` cũ chuyển `paused` (anh bấm Resume).

### Task 1: `src/meeting/core.ts` (thuần) + test
`speakersOf(cfg, seats, zaiEnabled)`, `parsePoints(text)`, `parseConclusion(text)`, `verifyEvidence(ev, ctx)`, `stepsOf(meeting)`, `meetingPrompt(...)`, `conclusionPrompt(...)`, `renderMeetingMd(m)`.
### Task 2: `src/meeting/github.ts` (`parseGithubUrl`, `fetchGithubMaterial(url, fetchFn)`) + `src/meeting/lane.ts` (`createMeetingLane`: start/stop/resume/close/conclude/tick) + test với runner giả
### Task 3: `POST /api/meeting`, snapshot `meeting`, host wiring, search
### Task 4: web/app/meeting.js (lựa chọn Meeting + Quick, biên bản, nút), mood auto Lively
### Task 5: VM ×3, PR, merge
