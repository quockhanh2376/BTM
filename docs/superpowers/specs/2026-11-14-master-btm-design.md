# Master BTM (MB) – thiết kế

Ngày 2026-11-14 · anh Zon + Cheki · Quyết định: `docs/decisions/0003-master-btm-api-key.md`

## Ý định
Anh Zon có key Z.ai gói Max. Muốn có một người dự phòng luôn sẵn sàng: agent nào trong team hết quota thì **MB vào ghế đó ngay**, để phiên không dừng. MB làm được mọi việc: lập plan (PM), code (Dev), QC, Audit. Sau này MB làm thêm audit bảo mật lần 2 sau Bruno.

## Mục tiêu
- MB là thành viên thứ 5: ID `mb` (user Linux `btm-mb`), tên hiển thị **"Boss"** (anh đổi được), dùng CLI Claude Code trỏ tới Z.ai.
- **Boss = worker** (anh Zon 2026-11-14): không có thêm quyền. Code của Boss vẫn qua gate, QC, audit; Boss không ra lệnh cho agent khác (PM điều phối, anh quyết). Trên thẻ chỉ thêm nhãn "Backup · mọi ghế".
- Thẻ mọi agent hiện ID mờ cạnh tên (ví dụ "Finn · elon") để đối chiếu với log.
- Ngồi được mọi ghế, **bất cứ lúc nào** (anh Zon 2026-11-14): anh gán Boss làm người chính cho Dev hoặc QC (hay PM, Audit) trên dashboard như agent khác, không cần chờ ai hết quota.
- Ngoài ra Boss đứng cuối danh sách `seats_backup` của mọi ghế: ghế nào hết quota mà chưa ai thay thì Boss vào.
- Luật cũ vẫn giữ: ai code ticket thì không QC chính ticket đó (`coder_cannot_qc_same_task`). Boss vừa Dev vừa QC thì ticket Boss code phải do người khác QC.
- Chọn model mặc định + đổi model trên dashboard như các agent khác.
- Key mã hoá trong DB; agent không bao giờ thấy key thật.

## Không làm (lần này)
- Audit lần 2 sau Bruno (làm sau, cần đổi luồng audit).
- Thêm key thứ hai, hoặc key cho Gemini/OpenAI.
- BTM tự chọn Boss thay người chính khi người chính vẫn còn quota (chỉ anh gán, hoặc dự phòng khi hết quota).

## Cách chạy một lượt MB
1. Phiên chọn người cho ghế như hiện nay (`pickSeatAgent`): người chính hết Energy → dự phòng theo thứ tự → tới MB.
2. Core tạo mã tạm cho lượt, chạy `claude` của user Linux `btm-mb` với:
   `ANTHROPIC_BASE_URL=http://127.0.0.1:<cổng trung gian>` và `ANTHROPIC_AUTH_TOKEN=<mã tạm>` (chỉ cho lượt này),
   model = model anh chọn cho MB.
3. Cổng trung gian (trong tiến trình BTM, chỉ nghe 127.0.0.1): kiểm mã tạm còn hạn → thay bằng key thật → chuyển tới Z.ai. Mã sai/hết hạn/MB bị tắt → 401.
4. Hết lượt: xoá mã tạm.

`login.forbidden_env` vẫn chặn các biến này với mọi agent khác; riêng MB được, và giá trị chỉ là mã tạm.

## Lưu key
- Bảng setting `mb_key`: `{ iv, tag, data }` (AES-256-GCM), không bao giờ trả qua API.
- Khoá giải mã: file 32 byte ngẫu nhiên `/var/lib/btm/keys/master.key` (0600, user chạy BTM), nạp qua systemd. Thiếu file → MB tắt, dashboard báo.
- Settings: ô dán key (password field) → `POST /api/mb/key` (header `x-btm`), trả lại chỉ `…abcd`. Nút "Tắt MB" / "Bật MB".

## Model
- Claude Code dùng danh sách model cố định (`CLAUDE_MODELS`). MB dùng danh sách riêng các model GLM, ghi trong config, anh sửa được; dashboard hiện danh sách đó ở ô chọn model như các agent khác.
- Tên model GLM chính xác lấy từ tài liệu Z.ai lúc thử thật, không đoán.

## Kiểm
- Test: mã hoá/giải mã đúng; API không bao giờ trả key; cổng trung gian từ chối mã sai/hết hạn/khi tắt; agent khác vẫn bị chặn biến key; MB được chọn khi mọi người khác hết Energy.
- Thử thật trên VM với project test: một lượt Dev nhỏ của MB.

## Còn để Cheki quyết khi làm
- Cổng trung gian dùng `node:http` có sẵn (không thêm thư viện); số cổng trong config.
- Lượt dài: mã tạm hết hạn khi lượt kết thúc hoặc quá `timeout_minutes` của lượt.
