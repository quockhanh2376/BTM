# Bảng chuỗi giao diện – VI hiện tại → EN đề xuất (Plan 5 Task 9, Step 0)

Anh duyệt bằng một trong ba cách:
- sửa thẳng cột **EN** trong file này;
- comment trên PR;
- nhắn e các dòng cần đổi.

Sau khi anh duyệt, cột **key** + **EN** thành `STRINGS.en` trong `web/i18n.js`. Bản tiếng Việt sau này lấy lại cột VI.

`{x}` là tham số, ví dụ `{seat}`, `{agent}`, `{pct}`, `{time}`, `{n}`. Thuật ngữ theo `docs/glossary.md`.

## 1. Thanh trên và nút chung

| key | VI hiện tại | EN đề xuất |
|---|---|---|
| conn.lost | Mất kết nối, đang thử lại… | Disconnected, retrying… |
| bar.project | Dự án: {name} | Project: {name} |
| bar.session | Phiên #{id} · {status} | Session #{id} · {status} |
| bar.noSession | Chưa có phiên / Phiên: — | No session |
| bar.turns | Đã dùng {used}/{max} lượt | Turns {used}/{max} |
| bar.holder | Đang giữ lượt: {seat} | Active seat: {seat} |
| btn.autoApprove | Auto duyệt thẻ | Auto-approve tickets |
| btn.refreshEnergy | Làm mới Energy | Refresh energy |
| btn.approve | Duyệt thẻ | Approve tickets |
| btn.stop | Dừng | Stop |
| btn.resume | Tiếp tục phiên | Resume |
| btn.theme | Chuyển sáng/tối | Toggle light/dark |
| confirm.stop | Dừng tất cả? Agent đang chạy sẽ bị dừng và hàng đợi sẽ bị xóa. | Stop everything? The running agent will be killed and the queue cleared. |
| confirm.stopCard | Dừng thẻ này? Lượt đang chạy của thẻ bị dừng; hàng đợi giữ nguyên. | Stop this card? Its running turn will be killed; the queue is kept. |
| seat.stopFor | Dừng {seat} | Stop {seat} |
| fb.stopSent | Đã gửi lệnh Dừng | Stop sent |
| fb.resumeSent | Đã gửi lệnh tiếp tục phiên | Resume sent |
| fb.approved | Đã duyệt thẻ | Tickets approved |
| fb.nothingToApprove | Không có thẻ chờ duyệt | No tickets awaiting approval |
| fb.energyRefreshed | Đã làm mới Energy | Energy refreshed |
| fb.seatChanged | Đã đổi người ngồi ghế {seat} | {seat} seat reassigned |
| fb.serverError | Lỗi máy chủ ({status}) | Server error ({status}) |

## 2. Mục tiêu phiên, thẻ ghế

| key | VI hiện tại | EN đề xuất |
|---|---|---|
| seat.idle | Rảnh | Idle |
| seat.running | Đang chạy | Running |
| seat.waiting | Chờ | Waiting |
| seat.started | Bắt đầu: | Started: |
| seat.turns | Số lượt: | Turns: |
| seat.agent | Người ngồi ghế | Seated agent |
| seat.lastLog | Dòng log cuối: | Last log: |
| seat.also | kiêm {seats} | also {seats} |
| seat.substitute | lượt cuối: {agent} ngồi thay | last turn: {agent} (substitute) |
| seat.warnings | Đội hình: {list} | Team: {list} |
| login.none | Đăng nhập: — | Login: — |
| login.ok | Ok | Ok |
| login.expiring | Sắp hết hạn {date} | Expires {date} |
| login.relogin | Cần đăng nhập lại | Re-login needed |
| login.apiKey | API key đè | API key override |
| login.unknown | Chưa rõ | Unknown |
| energy.5h | 5 giờ | 5h |
| energy.week | Tuần | Week |
| energy.left | còn {pct}% · hồi {time} | {pct}% left · resets {time} |
| energy.unavailable | Energy: không đọc được ({note}) | Energy: unavailable ({note}) |
| energy.low | Sắp hết · hồi {time} | Low · resets {time} |
| seat.avatarFor | Avatar của {agent}: bấm để chọn ảnh, chuột phải để bỏ | Avatar of {agent}: click to choose an image, right-click to remove |
| seat.avatarRemove | Bỏ avatar này? | Remove this avatar? |
| seat.avatarBad | Không đọc được ảnh này | Could not read that image |

## 3. Goal, ticket

| key | VI hiện tại | EN đề xuất |
|---|---|---|
| goals.title | Danh sách mục tiêu | Goals |
| goals.empty | Chưa có goal nào | No goals yet |
| stage.intake | Tiếp nhận | Intake |
| stage.plan | Lập kế hoạch | Planning |
| stage.dev | (Dev) | Dev |
| stage.test | Kiểm thử | Testing |
| stage.audit | Kiểm tra bảo mật | Security audit |
| stage.release | Phát hành | Release |
| goal.passed | {n}/{m} đạt | {n}/{m} passed |
| goal.noTickets | Không có ticket | No tickets |
| goal.noDesc | (Chưa có mô tả) | (No description) |
| goal.approveMerge | Duyệt merge | Approve merge |
| goal.confirmMerge | Duyệt merge goal G{n} vào nhánh chính? | Merge goal G{n} into main? |
| goal.merged | Đã duyệt và merge goal G{n} | Goal G{n} merged |
| goal.approveError | Lỗi duyệt goal | Goal approval failed |
| goal.released | GitHub {tag} ↗ | GitHub {tag} ↗ |
| goal.pushFailed | Push GitHub lỗi: {error} | GitHub push failed: {error} |
| goal.pushAgain | Push lại | Push again |
| goal.tableTitle | Bảng ticket G{n} | G{n} tickets |
| goal.col.title | Mục tiêu | Title |
| goal.col.rounds | Vòng sửa | Fix rounds |
| goal.col.updated | Cập nhật | Updated |
| ticket.pending | Chờ | Pending |
| ticket.inDev | Đang làm | In dev |
| ticket.awaitingQc | Chờ test | Awaiting QC |
| ticket.passed | Đạt | Passed |
| ticket.returned | Trả về | Returned |
| ticket.failed | Thất bại | Failed |
| ticket.blocked | Bị chặn | Blocked |
| history.loading | Đang tải lịch sử… | Loading history… |
| history.cannotLoad | Không thể tải lịch sử | Can't load history |
| history.empty | Chưa có lịch sử thay đổi | No history yet |
| history.error | Lỗi tải lịch sử | History load error |

## 4. Trạng thái phiên và hàng đợi

| key | VI hiện tại | EN đề xuất |
|---|---|---|
| status.awaitingApproval | Chờ duyệt | Awaiting approval |
| status.done | Hoàn tất | Done |
| status.needsOwner | Cần anh xem | Needs owner |
| status.outOfTurns | Hết lượt | Out of turns |
| status.stopped | Đã dừng | Stopped |
| status.refused | Bị từ chối | Refused |
| status.error | Lỗi | Error |
| queue.title | Phiên & hàng đợi | Session & queue |
| queue.goal | Goal {goal} | Goal {goal} |
| queue.empty | Không có gì đang chạy hay chờ | Nothing running or queued |
| queue.queued | Xếp hàng | Queued |
| queue.cancelled | Đã hủy | Cancelled |
| log.title | Nhật ký | Log |
| log.empty | Chưa có nhật ký | No log entries |
| log.started | bắt đầu {task} | started {task} |

## 5. Hộp thư team, khung lệnh

| key | VI hiện tại | EN đề xuất |
|---|---|---|
| inbox.title | Hộp thư team | Team inbox |
| inbox.empty | Chưa có ghi chú team | No team notes |
| inbox.open | Mở | Open |
| inbox.attachment | Ảnh đính kèm N-{id} | Attachment N-{id} |
| inbox.count | · {n} ghi chú · {open} đang mở | · {n} notes · {open} open |
| inbox.select | Chọn N-{id} | Select N-{id} |
| inbox.deleteSel | Xoá mục đã chọn | Delete selected |
| inbox.deleteAll | Xoá tất cả | Delete all |
| inbox.noneSelected | Chọn ghi chú trước | Select notes first |
| inbox.confirmSel | Xoá {list}? File bị xoá khỏi main; lịch sử git vẫn giữ. | Delete {list}? Files are removed from main; git history keeps them. |
| inbox.confirmAll | Xoá mọi ghi chú team? File bị xoá khỏi main; lịch sử git vẫn giữ. | Delete all team notes? Files are removed from main; git history keeps them. |
| inbox.deleted | Đã xoá {n} ghi chú | Deleted {n} note(s) |
| inbox.skipped | giữ lại {list} (phiên đang chờ còn dùng) | kept {list} (used by a waiting session) |
| cmd.title | Khung lệnh | Command |
| cmd.team | Cả team | Team |
| cmd.label | Nội dung lệnh hoặc mục tiêu: | Command or goal: |
| cmd.placeholder | Nhập mục tiêu cho PM, lệnh cho Dev/QC hoặc ghi chú cho Cả team... | Goal for PM, command for Dev/QC, or note for the team… |
| cmd.attach | Đính kèm ảnh | Attach image |
| cmd.removeImage | Bỏ ảnh | Remove image |
| cmd.send | Gửi lệnh | Send |
| cmd.imageType | Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP | PNG, JPEG or WebP only |
| cmd.imageSize | Ảnh vượt quá giới hạn 5 MB | Image over 5 MB |
| cmd.empty | Vui lòng nhập nội dung lệnh hoặc mục tiêu | Enter a command or goal |
| cmd.noteSent | Đã gửi ghi chú team thành công | Team note sent |
| cmd.sent | Đã gửi lệnh thành công | Command sent |
| cmd.failed | Gửi lệnh thất bại | Send failed |

## 6. Tài khoản

| key | VI hiện tại | EN đề xuất |
|---|---|---|
| acc.title | Tài khoản | Accounts |
| acc.import / acc.export / acc.add | Nhập / Xuất / + Thêm tài khoản | Import / Export / + Add Account |
| acc.workerTitle | {name} · tài khoản: {n} | {name} · accounts: {n} |
| acc.worker / acc.slug | Worker / Tên (a-z0-9) | Worker / Name (a-z0-9) |
| acc.agyPlaceholder | Dán {"email", "refresh_token"} hoặc chọn file JSON | Paste {"email": "…", "refresh_token": "…"} or choose a JSON file |
| acc.create / acc.cancel / acc.send | Tạo / Huỷ / Gửi | Create / Cancel / Send |
| acc.pasteCode | Dán mã | Paste code |
| acc.confirmImport | Xác nhận nhập | Confirm import |
| acc.badJson | JSON không hợp lệ | Not valid JSON |
| acc.created | Đã tạo tài khoản {key} | Account {key} created |
| acc.loginOpen | Mở link, đăng nhập rồi chờ ở đây | Open the link, sign in, then wait here |
| acc.loginCode | Mở link, đăng nhập rồi dán mã bên dưới | Open the link, sign in, then paste the code below |
| acc.loginDone | Đã đăng nhập – tài khoản {key} sẵn sàng | Signed in – account {key} is ready |
| acc.loginFailed | Đăng nhập lỗi: {error} | Login failed: {error} |
| acc.exported | Đã xuất – giữ kín file này (có token đăng nhập) | Exported – keep this file private (it contains login tokens) |
| acc.importNew | Mới: {list} | New: {list} |
| acc.importConflicts | Đã có – tick để ghi đè: | Already here – tick to overwrite: |
| acc.importRejected | Bỏ qua: {entry} ({reason}) | Skipped: {entry} ({reason}) |
| acc.importNothing | Không có gì để nhập | Nothing to import |
| acc.sleepingN | {n} tài khoản ngủ | {n} sleeping |
| acc.renameFor | Đổi tên Worker {agent} (chỉ hiển thị) | Rename worker {agent} (display only) |
| acc.renamePrompt | Tên hiển thị cho {agent} (1–24 chữ/số; để trống = mặc định): | Display name for {agent} (1–24 letters/numbers; empty = default): |
| acc.imported | Đã nhập {n} tài khoản – mặc định ngủ; bật Active here để dùng | Imported {n} account(s) – they start Sleeping; turn on Active here to use them |
| acc.activeHere / acc.activeFor | Dùng ở máy này / Dùng {key} ở máy này | Active here / Use {key} on this machine |
| acc.up / acc.down | Đưa {key} lên / xuống | Move {key} up / down |
| acc.st.* | Đang dùng / Kế tiếp / Bật, rảnh / Hết hạn mức · hồi {time} / Đang ngủ / Cần đăng nhập lại | In use / Next / Active, free / Usage limited · resets {time} / Sleeping / Re-login needed |
| acc.copyLoginItem | Copy lệnh đăng nhập cho {key} | Copy login command for {key} |
| acc.signIn / acc.signInFor | Đăng nhập / Đăng nhập {key} tại đây (xong thì bật) | Sign in / Sign in {key} here (turns it on when done) |
| acc.empty | Chưa có thông tin tài khoản | No account info |
| acc.loginCmd | Lệnh đăng nhập (cho {agent}) | Login command ({agent}) |
| acc.copy | Sao chép | Copy |
| acc.copyLogin | Sao chép lệnh đăng nhập cho {agent} | Copy login command for {agent} |
| acc.copied | Đã sao chép | Copied |
| acc.copyManual | Hãy bôi đen và Ctrl+C | Select and press Ctrl+C |
| acc.modelFor | Model cho {agent} | Model for {agent} |
| acc.cliDefault | Mặc định của CLI | CLI default |
| acc.effortFor | Mức suy luận cho {agent} | Effort for {agent} |
| acc.save | Lưu | Save |
| acc.saveFor | Lưu model và mức suy luận cho {agent} | Save model and effort for {agent} |
| acc.saved | Đã lưu model/effort cho {agent} (áp từ lượt kế) | Saved for {agent} (applies next turn) |

## 7. Thông báo từ server (API trả mã, dashboard dịch)

| key / mã | VI hiện tại | EN đề xuất |
|---|---|---|
| err.no_active_project | Chưa có dự án active | No active project |
| err.busy | Phiên/lượt đang chạy · Đang có phiên chạy · Đang có phiên/lượt chạy | Session running |
| err.stopping | Đang dừng (phiên) | Stopping |
| err.terminal_session | Phiên đang chạy từ terminal, dừng bằng Ctrl-C | Session started from terminal – stop it with Ctrl-C |
| err.nothing_to_approve | Không có phiên chờ duyệt | No session awaiting approval |
| err.nothing_to_resume | Không có phiên cần tiếp tục | No session to resume |
| err.bad_target | Người nhận không hợp lệ | Invalid recipient |
| err.bad_length | Độ dài lệnh phải từ 1 đến 2000 ký tự | Command must be 1–2000 characters |
| err.bad_seat | Ghế "{seat}" không hợp lệ | Invalid seat "{seat}" |
| err.seat_not_allowed | Agent "{agent}" không thể ngồi ghế "{seat}" | {agent} can't sit in {seat} |
| err.unknown_agent | Agent "{agent}" không tồn tại | Unknown agent "{agent}" |
| err.bad_model | Model hoặc effort không hợp lệ | Invalid model or effort |
| log.seatChange | Đổi ghế {seat}: {from} → {to} | {seat} seat: {from} → {to} |
| log.teamNote | Xử lý ghi chú team N-{id}: {text} | Team note N-{id}: {text} |
| login.checkFailed | Không kiểm tra được | Check failed |
| login.apiKeyDetail | API key đè đăng nhập: {keys} | API key overrides login: {keys} |
| login.expiresDetail | Hết hạn {date} | Expires {date} |
| login.noUser | Chưa có user {user} – chạy: sudo BTM_AGENTS="{agent}" bash deploy/isolation-setup.sh prep, rồi đăng nhập CLI dưới user đó | No Linux user {user}. Run: sudo BTM_AGENTS="{agent}" bash deploy/isolation-setup.sh prep, then log in as {user} |
| energy.gate | energy:{window} còn {pct}%, hồi lúc {time} | energy:{window} {pct}% left, resets {time} |
| energy.claudeUsage | Claude /usage không đọc được (lệnh chưa có trong tài liệu) | Claude /usage unavailable |
| energy.codexNoData | Không có dữ liệu hạn mức trong sessions codex | No Codex quota data yet |
| energy.agyParse | Không phân tích được hạn mức agy từ output | Couldn't parse agy quota |
| energy.timeout | Lệnh đọc hạn mức quá thời gian (timeout) | Quota check timed out |
| energy.unsupported | Công cụ {tool} không hỗ trợ đọc hạn mức | Quota not supported for {tool} |
| energy.agyFailed | Lệnh agy /quota thất bại (exit code {code}) | agy /quota failed (exit {code}) |
| team.ignored | Bỏ qua {source}: ghế {seat} = "{id}" (agent không có hoặc không được ngồi ghế này) | Ignored {source}: {seat} = "{id}" (unknown or not allowed) |
| team.src.legacy | đổi ghế cũ | legacy override |
| team.src.dashboard | đổi ghế trên dashboard | dashboard override |
| team.yamlInvalid | team/project.yaml: YAML lỗi, dùng đội hình mặc định | team/project.yaml: invalid YAML, using default team |
| team.seatsNotMap | team/project.yaml: seats phải là bảng ghế → agent | team/project.yaml: seats must map seat → agent |
| team.seatsIgnored | team/project.yaml: bỏ qua seats.{key} | team/project.yaml: ignored seats.{key} |
| goal.err.unreviewed | có commit lệnh trực tiếp chưa review | has unreviewed direct-command commits |
| goal.err.noReviewed | goal chưa có commit đã QC/audit | no QC'd or audited commit yet |
| goal.err.cantCheck | không thể kiểm tra commit lệnh trực tiếp | can't check direct-command commits |
| goal.err.branchMoved | nhánh goal đã đổi sau khi QC/audit | goal branch changed after QC/audit |
| note.hardRule | {agent}: luật cứng | {agent}: hard rule |
| note.unfinished | Các thẻ chưa hoàn thành (failed/blocked): {list} | Unfinished tickets (failed/blocked): {list} |
| notify.needs_owner | Can anh xu ly | Needs you |
| notify.awaiting_approval | Cho anh duyet | Awaiting approval |
| notify.done | Xong | Done |
| notify.stopped | Da dung | Stopped |
| notify.out_of_turns | Het luot | Out of turns |

## Ngoài phạm vi Task 9 (giữ tiếng Việt)

- Prompt gửi agent: `src/core/prompts.ts`, `team/prompts/`.
- Tài liệu: `docs/`, `team/`.
- File tổng kết goal ghi vào repo, ví dụ header `| # | Ticket | Tiêu đề | Trạng thái | Vòng sửa |`. Có thể đổi sau nếu anh muốn.
- Output lệnh `btm` trên terminal: Task 9 đổi luôn, theo cùng glossary.
| nav.dashboard / nav.accounts / nav.goals / nav.instances / nav.logs | Mục sidebar | Dashboard / Accounts / Tasks & Goals / Instances / Logs |
| nav.reports / nav.settings / nav.soon / nav.soonMsg | Mục chưa làm (phần dư Plan 9) | Reports / Settings / Soon / {name}: coming soon |
| nav.label / nav.collapse / nav.open | Điều hướng / Thu gọn / Mở menu | Navigation / Collapse / Open menu |
| page.title / page.sub | Tiêu đề trang | Dashboard / Team, sessions and accounts at a glance |
| head.refresh / head.bell / head.help / head.helpMsg / head.lang / head.viSoon / head.owner | Nút header | Refresh energy / Things waiting for you / Help / … / Language / Tiếng Việt: coming soon / Owner |
| sys.title / sys.healthy / sys.busy | Trạng thái máy | System status / Healthy / Busy |
| kpi.label / kpi.accounts / kpi.running / kpi.goals / kpi.tasks | Thẻ số | Summary / Total accounts / Running instances / Active goals / Total tasks |
| seat.lastRun / seat.onTask / seat.runs / seat.run1 | Lượt gần nhất / Trên ticket / {n} lượt / 1 lượt | Last run: / On ticket: / {n} runs / 1 run |
| seat.live | Đang chạy | Live |
| q.attach / q.imageAlt / q.removeImage | Ảnh / Ảnh cho câu hỏi {id} / Bỏ ảnh | Image / Image for question {id} / Remove image |
| q.seeImage | Xem ảnh đính kèm. | See attached image. |
| acc.addShort | Thêm tài khoản | Add Account |
| agents.title / agents.view / agents.card / agents.refresh | Agents ({n}) / Xem: / Thẻ / Làm mới | Agents ({n}) / View: / Card / Refresh |
| inbox.expand / inbox.collapse / inbox.new / goals.add / log.full / log.less | Mở rộng / Thu gọn / Ghi chú mới / Thêm goal / Xem toàn bộ log / Thu gọn | Expand / Collapse / New note / Add Goal / View full logs / Show less |
| folders.tab / folders.refresh / folders.repo / folders.branch / folders.commit / folders.dirty / folders.synced / folders.projects | Thư mục / Làm mới / Repo chính / Nhánh / Commit cuối / File đang sửa / Đồng bộ lần cuối / Project | Folder / Refresh / Main repo / Branch / Last commit / Changed files / Last sync / Projects |
| folders.tree / folders.truncated / folders.notCreated / folders.shared / folders.readOnly / folders.loading / folders.failed / folders.noProject | Cấu trúc ({n} file) / chỉ hiện {n} file đầu / Chưa có thư mục (account chưa chạy) / Không cách ly: mọi account làm trong repo chính. / Chỉ xem, chỉ tên file, không nội dung. / Đang tải… / Không đọc được / Chưa có project | Structure ({n} files) / showing first {n} files / Folder not created yet / No isolation… / View only… / Loading folders… / Could not read folders / No active project |
| goal.col.tags / log.filterAll / log.filterErr | Nhãn / Lọc: Tất cả / Chỉ lỗi | Tags / Filter: All / Errors only |
| ask.stopTicket / ask.stopTask / ask.stopNote / ask.keep / ask.yesStop | (Tiếng Việt làm sau) | Do you want me to stop working on {ticket}? / Do you want me to stop my current task? / I will end this turn and keep the work I have done so far. The queue stays as it is. / Keep working / Yes, stop |
| ask.team / ask.stopAll / ask.stopAllNote / ask.keepAll / ask.yesStopAll | (Tiếng Việt làm sau) | Team / Do you want us to stop everything? / The running turn ends and the queue is cleared… / Keep going / Stop everything |
| chat.aria / chat.en / chat.vi / chat.off / chat.waiting | Bong bóng thoại / Chat: EN / Chat: VI / Chat: Tắt / Đang chờ trả lời | Chat bubbles / Chat: EN / Chat: VI / Chat: Off / Waiting for a reply |
| cmd.nothingToResume | Không có gì để tiếp tục: phiên không ở trạng thái dừng. | Nothing to resume: the session is not paused. |
| mic.start / mic.stop / mic.lang / mic.listening / mic.blocked / mic.error | Nói để nhập / Dừng nói / Ngôn ngữ giọng nói / Đang nghe… nói đi, bấm mic lần nữa để dừng. / Mic bị chặn, cho phép trên thanh địa chỉ. / Nhập giọng nói dừng: {err} | Voice input / Stop voice input / Voice language / Listening… / Microphone is blocked… / Voice input stopped: {err} |
| mic.service / mic.none | Trình duyệt chặn dịch vụ nhận diện, dùng Chrome hoặc Edge / Không thấy mic, qua RDP bật "Record from this computer" rồi kết nối lại | The browser blocks its speech service… / No microphone found… |
| q.multiHint | Một câu trả lời chung cho cả {n} câu, hoặc ghi "1. … 2. …" để trả lời riêng. | One answer for all {n} questions, or write "1. … 2. …" to answer each one. |
| q.clear | Xoá câu trả lời | Clear answer |
| q.delegate / q.delegateTip / q.delegateSent / q.teamGuard / q.teamGuardOk / q.teamGuardCancel | Để {name} trả lời / … / {name} đang trả lời… / Đang có câu hỏi; tin cho Team sẽ tạo goal MỚI… / Tạo goal mới / Huỷ | Let {name} answer / … |
| trash.* | Thùng rác ({n}) / Thùng rác trống / Chuyển G{n} vào thùng rác? / Khôi phục / Xoá vĩnh viễn / … | Trash ({n}) / Trash is empty / Move G{n} to Trash? / Restore / Delete permanently / … |
| ticket.retry / ticket.askRetry / ticket.retryOk / ticket.retried | Làm lại / {ticket} đang {state}, làm lại nhé? / Ừ, làm lại / Đã mở lại {list}, bấm Resume | Retry / … |
| goal.timeLine / goal.timeRunning / goal.timeTip | {total} tổng · agent {agent} ({seats}) · chờ {wait} / đang mở / Từ {from} tới {to} (giờ VN) | {total} total · agents {agent} ({seats}) · waiting {wait} / still open / … |
| cmd.pmGuard / cmd.pmGuardNote | Em lập thành GOAL MỚI nhé? / Tin gửi PM sẽ tạo goal; hỏi chuyện cũ thì hỏi Audit/QC | Should I plan this as a NEW goal? / … |
| cmd.auto / auto.* | Tự động / Anh Zon, đây là câu hỏi hay goal mới? / Câu hỏi / Goal mới / Project mới cần repo riêng / Em lập thành GOAL MỚI nhé? / Đã hỏi {name} / {name} đang soạn 2–3 job kế tiếp | Auto / … |
| goal.summary / goal.summaryTip | Tóm tắt / Lịch sử nén của goal, team trả lời câu hỏi dựa trên đây | Summary / … |
