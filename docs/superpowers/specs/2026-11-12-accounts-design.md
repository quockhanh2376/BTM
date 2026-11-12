# Accounts: thêm tài khoản, export/import, dự phòng theo thứ tự

Thiết kế cùng anh Zon, 2026-11-12. Hai lựa chọn của anh:

- Hướng xây dựng: **B (mỗi tài khoản là một user Linux)**.
- Cách tổ chức: **mỗi agent là một nhân vật có nhiều tài khoản**.

Đã qua một vòng builder check.

## Vì sao

Cài BTM lên máy mới thì chưa có tài khoản nào. Anh muốn:

- thêm từng tài khoản ngay trên dashboard;
- gom mọi tài khoản vào một kho (anh có nhiều tài khoản agy a, b, c, d, cùng các tài khoản claude và codex);
- export kho ra file JSON và import vào BTM trên máy khác;
- trên mỗi máy chỉ bật một số tài khoản, ví dụ a chạy ở máy A, b chạy ở máy B;
- khi tài khoản đang chạy hết quota thì tự đổi sang tài khoản dự phòng anh đã chọn tay, theo đúng thứ tự;
- nhìn một chỗ là biết tài khoản nào đang nằm ở đâu.

## Mô hình

Tên trên giao diện: nhân vật gọi là **Worker**, tài khoản gọi là **Account** (anh Zon chốt 2026-11-12). Trong tài liệu này "agent" nghĩa là Worker. Code bên trong giữ tên cũ (`cfg.agents`, `worker_prefix`…), không đổi tên hàng loạt.

- **Agent** (nhân vật, trên UI là **Worker**): elon, jacky, jenny…
  - Giữ những gì có sẵn trong yaml: `tool`, `command`, `needs_pty`, `can_sit`, model, effort.
  - Ngồi ghế, ký commit (`jacky@btm.local`), hiện tên trong log.
  - Tất cả giữ nguyên như hiện nay.
- **Tài khoản** (account): thuộc đúng **một** agent và dùng `tool` của agent đó.
  - Mỗi tài khoản là một user Linux `<worker_prefix><agent>-<slug>`, ví dụ `btm-jacky-b`. Riêng **tài khoản đầu tiên là user hiện có** `btm-jacky`, nên VM đang chạy không phải đăng nhập lại.
  - Có các trường: `slug`, `email` (nếu biết), `label` (nhãn tay: none / IDE / CLI / Plugin / Other machine), `active_here` (bật trên máy này), `order` (thứ tự trong agent).
  - Token nằm trong home của user đó. CLI tự làm mới token, BTM không copy token qua lại.
- **Tài khoản đang ngủ** (`active_here = false`): BTM **không chạy bất cứ lệnh gì bằng user đó**, gồm cả lượt chạy, đọc energy và kiểm tra đăng nhập. Lý do: tài khoản này có thể đang chạy ở máy khác, đụng vào sẽ làm máy kia bị đăng xuất. Riêng việc **đọc file token để export thì vẫn làm được**, vì đọc file không dùng đến token.
- **Mỗi lượt chạy**, agent dùng **tài khoản đầu tiên còn dùng được** theo `order`. Một tài khoản dùng được khi thoả cả ba điều kiện:
  - đang bật trên máy này;
  - không bị giới hạn quota, hoặc đã qua giờ reset;
  - đăng nhập Ok.

  Ví dụ: a hết quota thì chuyển sang b. Khi b hết, nếu a đã qua giờ reset thì quay về a. Hết sạch tài khoản thì agent coi như hết, và cơ chế đổi **agent** khác ngồi thay (`seats_backup`, Plan 5/6) chạy như cũ. Không còn ai thì dừng và gửi ntfy.
- **Giới hạn quota và energy được tính theo từng tài khoản**, không theo agent. Các khoá setting đổi từ `usage_limited_until:<agent>` sang theo tài khoản.
- **Thứ tự tài khoản lưu trong DB, áp dụng cho cả máy, không phụ thuộc project.**

## Mục tiêu

- **Add Account:** trên thẻ của từng agent có nút "+ account".
  - **codex:** chạy `codex login --device-auth` bằng user mới, hiện link và mã trên dashboard, chờ lệnh kết thúc.
  - **claude:** chạy `claude auth login`, hiện link, có ô để anh dán mã trả về (đưa vào stdin).
  - **agy:** không có lệnh đăng nhập ngoài giao diện TUI (đã kiểm tra `agy --help` trên VM). Anh dán hoặc chọn file JSON có `email` và `refresh_token`. Muốn có token này, anh đăng nhập một lần qua ssh.
  - Tài khoản mới mặc định **bật** và đứng cuối thứ tự.
- **Export:** tải về một file JSON trần (quyết định của anh Zon), gồm mọi tài khoản, kể cả tài khoản đang ngủ.
  - Định dạng: `{version: 1, accounts: [{agent, slug, tool, email, label, files: {<tên file token>: <nội dung>}}]}`.
  - Không đưa vào file: cờ `active_here`, thứ tự, định nghĩa agent.
- **Import:** nhận file trên.
  - Chỉ nhận tài khoản thuộc agent đã có trên máy này, cùng `tool`. Các mục khác bị bỏ qua và báo lại cho anh.
  - Với từng tài khoản: tạo user Linux nếu chưa có, ghi file token, khôi phục `email` và `label`.
  - Tài khoản mới import **mặc định ngủ** và đứng cuối thứ tự.
  - Trước khi ghi đè tài khoản đã tồn tại, dashboard hiện danh sách và hỏi xác nhận.
- **Đổi tài khoản thì gửi ntfy**, ví dụ `jacky: a → b`.
- **Lưới an toàn:** tài khoản đang bật mà chuyển từ Ok sang Re-login needed thì gửi ntfy "`jacky/b` logged out – maybe used on another machine", và bỏ qua tài khoản đó cho đến khi đăng nhập lại Ok.
- **Khu Accounts trên dashboard:**
  - Tiêu đề có 4 nút: Import, Export, **Refresh energy** (chuyển từ thanh phiên xuống, chỉ giữ một nút), Add Account.
  - Các tab: **All · BTM · IDE · CLI · Plugin**.
    - Tab BTM: tài khoản đang bật trên máy này.
    - Các tab IDE/CLI/Plugin: lọc theo nhãn tay.
  - Thẻ agent hiện danh sách tài khoản theo thứ tự. Anh sắp thứ tự bằng nút ↑/↓, bật/tắt Active here, và chọn nhãn cho từng tài khoản.
  - Huy hiệu của mỗi tài khoản: `In use` / `Next` / `Active, free` / `Usage limited · resets HH:MM` / `Sleeping` / `Re-login needed`.
  - Energy hiện theo tài khoản đang dùng.

## Không làm

- Khoá chung giữa các máy.
- Mã hoá file export.
- Đăng nhập agy ngay trên dashboard.
- Đo quota của tài khoản đang ngủ.
- Xoá tài khoản hoặc xoá user Linux (tạm thời tắt Active here).
- Tự phát hiện IDE/Plugin.
- Thêm hoặc xoá **agent** trên dashboard (agent vẫn khai báo trong yaml).
- Đổi tên hiển thị của Worker (bút chì cạnh tên) và avatar tròn nhỏ bên trái tên: anh muốn có **sau này**. Đợt này không làm, nhưng không được chặn đường làm sau. Mọi chỗ trong DB, tên user Linux và người ký commit đều dùng **id cố định** (`jacky`). Tên hiển thị chỉ là một lớp bên trên, nên sau này đổi tên chỉ đụng tới phần hiển thị.

## Những thứ tuyệt đối không được xảy ra

- Token lọt vào git, log, ntfy, snapshot/SSE, thông báo lỗi, hoặc output của `console.log`.
- Dashboard đụng được user không thuộc nhóm `btm-workers`, hoặc đọc/ghi file ngoài danh sách file token cố định của từng tool.
- Export hoặc Import gọi được mà không qua guard `x-btm` + Origin.
- BTM chạy lệnh bằng user của tài khoản đang ngủ.
- Sau khi nâng cấp, VM hiện tại phải đăng nhập lại, hoặc agent đổi tên người ký commit.

## Ràng buộc

- **Công cụ sudo hẹp mới `/usr/local/bin/btm-account`**, cài bằng `deploy/isolation-setup.sh prep`, sudoers chỉ cho user `agent`. Có 3 lệnh:
  - `add <user>`: tạo user y như bước prep hiện nay.
  - `export <user> <tool>`: in nội dung các file token ra stdout.
  - `import <user> <tool>`: đọc stdin, ghi file với quyền 0600, chủ sở hữu là user đó, không đi theo symlink.
  - Tên user phải khớp `^<prefix>[a-z0-9-]+$`. `export` và `import` chỉ nhận user thuộc nhóm `btm-workers`.
  - File token theo tool:
    - claude: `~/.claude/.credentials.json`
    - codex: `~/.codex/auth.json`
    - agy: `~/.gemini/antigravity-cli/antigravity-oauth-token`
- **Đăng nhập, lượt chạy và đọc energy** đều chạy bằng user của tài khoản được chọn, qua `btm-worker-exec`.
  - Workspace gắn với user nên mỗi tài khoản có workspace riêng.
  - Workspace được đồng bộ lại mỗi lượt, giống như hiện nay.
- **Định dạng file token của agy:** kiểm tra trên VM bằng cách chỉ xem **tên các key**, không in giá trị, để map đúng `{email, refresh_token}`.
- **Agent trong yaml được giữ nguyên.** Lần chạy đầu sau nâng cấp, mỗi agent tự có tài khoản `default` = user hiện có, đang bật, đứng đầu thứ tự.
- **Không dùng API key.** Việc đưa token OAuth vào file export JSON trần là quyết định của anh Zon. Ghi quyết định này thành `docs/decisions/0005-account-export.md`.
- Mọi chữ trên giao diện đi qua `STRINGS.en` / `tx()`. Nội dung từ agent hoặc từ file hiển thị bằng `textContent`.

## Các cách đã cân nhắc

**Hướng xây dựng:**
- **A. Kho token + hoán đổi:** bỏ, vì token bị đổi liên tục, copy ngược mà sót là hỏng tài khoản.
- **B. Mỗi tài khoản một user Linux:** chọn, vì dùng lại được cơ chế cô lập đang chạy thật.
- **C. Một user, nhiều thư mục cấu hình:** bỏ, vì chưa thấy agy hỗ trợ.

**Cách tổ chức:**
- **1. Agent là nhân vật có nhiều tài khoản:** chọn. Tên, người ký commit và model giữ nguyên, chỉ tài khoản bên dưới thay đổi.
- **2. Mỗi tài khoản là một agent riêng:** bỏ, vì dashboard sẽ đầy agent và log ghi tên tài khoản.

## Quyết định của người viết thiết kế (anh xem lại)

- Tài khoản ngủ vẫn được export.
- File export không chứa cờ Active here, thứ tự, hay định nghĩa agent.
- Tài khoản mới import mặc định ngủ.
- Tài khoản tạo bằng Add Account mặc định bật.
- Thứ tự tài khoản áp dụng cho cả máy, không phụ thuộc project.

## Để người làm tự quyết

- Bảng DB và cách gộp tài khoản vào runner, energy monitor và kiểm tra đăng nhập.
- Cách giữ tiến trình đăng nhập (pty hoặc pipe) và thời gian chờ.
- Bố cục cụ thể của thẻ agent, danh sách tài khoản và các tab.
