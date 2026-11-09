# P4-T6 · fix 1 · Victor · Khôi phục test bị xoá

P4-T6 chạy đúng nhưng **xoá test**: tests/session.test.ts 71 → 14, tests/qc.test.ts 32 → 3. Code các luật vẫn còn, nên mất test = mất lưới an toàn. Không chấp nhận.

**Làm:** với MỖI test cũ dưới đây (bản cũ: `git show HEAD:tests/session.test.ts`, `git show HEAD:tests/qc.test.ts`), viết lại test tương đương cho luồng goal/ticket (ID `GTM-0001`, `team/tickets/`, nhánh `goal/G1-…`, `parseTicketQcResult`, `*TicketPrompt`). Giữ nguyên ý kiểm tra và giá trị kỳ vọng.
Chỉ được bỏ test nếu tính năng đó đã bị thay thế hẳn bởi luồng mới (vd `session_tasks`, nhánh `session/<id>`, `pmPrompt` cũ) – khi đó ghi tên test + lý do vào báo cáo, mỗi dòng 1 test.

**Scope:** tests/session.test.ts, tests/qc.test.ts, tests/prompts.test.ts. KHÔNG sửa src/ (nếu test lộ bug thật trong src → ghi 'Bug:' vào báo cáo, không tự sửa).
**Xong khi:** session.test.ts ≥ 60 test, qc.test.ts ≥ 28 test (hoặc số bỏ có lý do trong báo cáo); `npx tsc --noEmit` sạch; `npx vitest run` không tăng fail (18 Windows).
**Báo cáo:** ghi đè team/reports/P4-T6-dev.md – dòng 1: số test session/qc trước → sau; sau đó danh sách test bỏ + lý do; Bug nếu có.

## Test cũ tests/session.test.ts (71)
- pmPrompt is <= 6 lines, Vietnamese, mentions front matter YAML and quoting strings with 
- devPrompt is <= 6 lines, Vietnamese, mentions reading task file with acceptance, reports path, fix notes, merges newlines, forbids git commit and push, and lists allowed commands with restrictions
- qcPrompt is <= 6 lines, Vietnamese, mentions reading task file with acceptance, merges newlines, forbids git commit and push, with JSON at the end
- pmPrompt with notes instructs reading note and image and writing note: N-<id> in front matter
- devPrompt and qcPrompt with card having note include note path and image instructions
- happy path: PM writes T-001 -> Dev modifies scope + report -> QC passes
- awaiting approval: approved: false stops after PM turn without calling Dev
- PM edits file outside team/tasks/ -> does not commit them, needs_owner (pm_out_of_scope)
- QC modifies repo (dirty working tree or commit) -> QC fail lý do qc_modified_repo, không pass
- gate reject then fix: round 1 Dev edits out of scope, round 2 fixes it -> passed
- fix rounds exhausted: QC fails 3 times with max_fix_rounds: 2 -> failed, needs_owner
- out of turns: max_turns: 3 stops out_of_turns, runner not called 4th time
- refused on API key in env
- refused when repo is outside projects_root
- refused when goals count is 0 or exceeds max_goals
- timeout makes WIP commit: Dev timedOut: true -> WIP T-001 commit, needs_owner
- invalid QC output: prose instead of JSON -> fail with qc_output_invalid
- Dev reports BLOCKED -> task blocked, needs_owner
- coder_cannot_qc_same_task: stops with needs_owner if QC is same agent as Dev
- PM creates invalid card (CardError) -> needs_owner
- hết lượt theo ghế: dev exceeds max_turns_per_seat.dev -> out_of_turns
- giữ lượt PM (reserve): reserve_turns_for_pm blocks non-PM from consuming reserved turns
- đổi coder giữa vòng: coder_cannot_qc stops when QC matches ANY agent that coded the task
- author commit = agent dev: commits created by Dev use Dev agent identity
- Dev không đổi gì → gate empty_diff, QC không được gọi (max_fix_rounds: 0)
- Runner throw: dev runner throws -> endTurn(
- Lượt thành công chỉ khi exitCode===0 và !timedOut: non-zero exitCode triggers error turn and needs_owner
- Checkout nhánh và mọi bước nằm trong try/finally để luôn setSessionStatus
- commitAll lỗi sau lượt → lượt đã có ended_at, session có status cuối
- runner trả exitCode:null, timedOut:false → lượt 
- chỉ cho session awaiting_approval: throw khi session khác awaiting_approval hoặc không tồn tại
- resumeSession từ chối session khác project mà KHÔNG đổi status của nó
- resumeSession checkout session/<id>, bỏ qua lượt PM (PM không gọi lần 2), chạy tiếp từ Dev
- session passes cfg.runner.agy_allow_commands into devPrompt
- Dev output containing auto-denied records handoff failure command_denied and adds fixNote for next round
- Dev output containing auto-denied with non-zero exit code is handled as command_denied fix round
- happy path ghi đúng chuỗi pending → in_dev → awaiting_qc → passed
- QC rớt một lần → có returned với fix_rounds: 1 rồi passed
- mỗi lượt có log_file = <logDir>/turn-<id>.log trước khi runner được gọi (runner giả đọc listTurns thấy đã có)
- gate rớt còn vòng → returned (fix_rounds: 1); hết vòng → failed; BLOCKED → blocked
- P2-T8 A: thẻ T-001 cũ có sẵn + PM tạo T-002 → chỉ T-002 được làm
- P2-T8 A: resumeSession dùng đúng tập thẻ của commit PM của phiên đó (session_tasks)
- P2-T8 A: khi PM bị abort hoặc timeout: commitAll WIP trên nhánh phiên để working tree sạch
- P2-T8 A: đầu phiên working tree bẩn → commitAll 
- P2-T8: config require_task_approval=false nhưng approved=false → awaiting_approval
- P2-T8: chỉ parse thẻ trong diff PM; thẻ cũ hỏng + PM tạo T-002 hợp lệ → chạy được cả runSession và resumeSession
- P2-T8: resume với session_tasks rỗng → needs_owner 
- Task 10a: phiên done + thẻ passed → note done; khác → needs_owner, note open
- lỗi ghi/commit khi đóng note → note giữ open trong DB, phiên needs_owner với lý do, không nuốt lỗi
- Task 10a: commit đóng note lỗi → khôi phục file về status: open (git checkout file) rồi needs_owner
- passes card note image absolute path to QC runner options
- noteId chỉ truyền tường minh qua opts (không suy từ chuỗi goal) và chỉ gắn note cùng project
- P2-T10c: repo đang ở nhánh session cũ có commit lạ; gửi note → nhánh phiên mới chứa team/inbox/N-x.md và ảnh, nhánh cũ không bị đổi; runner giả của lượt PM thấy file tồn tại
- P2-T10c: lỗi ghi note/ảnh trong runSession → xóa file vừa ghi, xóa bản ghi note, phiên needs_owner
- P2-T10c: lỗi commitAll inbox note trong runSession → xóa file vừa ghi, xóa bản ghi note, phiên needs_owner
- energy 15% với ngưỡng 20 → lượt Dev không chạy, needs_owner, note có 
- energy unknown → chạy bình thường
- login relogin cho QC → Dev vẫn chạy, tới QC thì dừng
- gọi refresh(mọi agent đang ngồi ghế) khi mở phiên và refresh([agent]) trước mỗi lượt
- refresh reject khi mở phiên -> coi như unknown, phiên tiếp tục bình thường và setSessionStatus được gọi
- refresh reject khi resume phiên -> coi như unknown, phiên tiếp tục và luôn setSessionStatus trong finally
- test tích hợp session + monitor thật: Energy 50% ở lượt Dev, tụt 10% trước lượt QC -> QC không chạy, needs_owner có 
- effectiveSeats returns cfg.seats by default and overridden seat from store setting
- effectiveSeats ignores override if agent not in cfg.agents or can_sit does not contain seat, and logs
- resumeSession resumes needs_owner and stopped sessions without calling PM, preserving fix_rounds and non-pending states
- devPrompt includes handoff instruction when handoff is true and omits it when false
- when dev is swapped to jenny: next dev turn calls runner with jenny
- when jenny coded card and qc is also jenny: QC fails with coder_cannot_qc_same_task and needs_owner
- prompt bàn giao xuất hiện khi Dev của một thẻ đang returned/in_dev khác agent đã code thẻ đó trước
- dừng sau gate, resume → QC prompt chứa base_sha cũ và diff không rỗng
- kết thúc phiên: nếu còn thẻ failed/blocked (kể cả có từ trước khi resume) → needs_owner kèm danh sách thẻ, không 

## Test cũ tests/qc.test.ts (32)
- parses valid pass result
- parses valid fail result with bugs, fix, and confirm
- parses JSON inside 
- returns qc_output_invalid for plain 
- returns qc_output_invalid for raw JSON embedded in prose without code fence
- returns qc_output_invalid for pure prose without JSON
- returns qc_output_invalid for empty string or whitespace
- returns qc_output_invalid for malformed JSON syntax
- returns qc_output_invalid for unclosed braces
- returns qc_output_invalid when JSON does not conform to schema
- returns qc_output_invalid for invalid verdict value
- returns qc_output_invalid if bugs or fix is not a string array
- never throws for null or undefined input
- coerces pass to fail when bugs is not empty
- coerces pass to fail when fix is not empty
- coerces pass to fail when both bugs and fix are not empty
- does not coerce pass to fail when only confirm is not empty
- defaults missing confirm to empty array
- defaults missing bugs and fix to empty arrays
- transforms null values to empty arrays
- extracts the last JSON block when multiple blocks exist
- handles curly braces inside strings without getting confused
- handles prose containing braces before the JSON block
- extracts last 
- returns qc_output_invalid without backtracking when last JSON block fails schema validation
- returns qc_output_invalid for cut-off JSON with nested valid JSON
- returns qc_output_invalid when trailing JSON block is incomplete / cut off
- returns qc_output_invalid when prose has raw JSON without code fence
- does not affect subsequent invalid results when mutating returned invalid arrays
- parses valid ticket qc result with matching ticket, goal, number
- returns fail + qc_output_invalid khi thiếu ticket hoặc ticket sai
- returns fail + qc_output_invalid khi number lệch hoặc goal lệch
