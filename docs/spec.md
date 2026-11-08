# BTM – Bot Task Manager · Spec v1.0

> Trạng thái: bản nháp để bắt đầu · Ngày: 07/11/2026
> Mọi con số vận hành (giới hạn lượt, timeout, ngưỡng Energy…) nằm trong `btm.config.yaml`.
> Tài liệu này chỉ mô tả ý nghĩa, không ghi lại con số để tránh hai nơi lệch nhau.

## 1. Mục tiêu

BTM điều phối một team dev gồm các AI agent, mỗi agent chạy bằng CLI của một hãng và đăng nhập bằng tài khoản subscription riêng (không dùng API key). Anh (chủ dự án) giao 1–3 mục tiêu mỗi phiên; PM tách việc, Dev làm, QC nghiệm thu; anh theo dõi trên dashboard và ra lệnh qua khung lệnh.

v1.0 ưu tiên: **an toàn, chạy tuần tự, dễ quan sát**. Tốc độ và chạy song song để v2.0.

## 2. Nguyên tắc bất biến

1. **An toàn trước.** Không API key. Không chế độ tự chạy: BTM chỉ chạy khi anh mở phiên, hết mục tiêu hoặc hết lượt là dừng hẳn.
2. **Code đảm bảo luật, AI không tự nhớ luật.** Khóa lượt, giới hạn lượt, timeout, phạm vi file đều do Core kiểm tra.
3. **Repo là nguồn sự thật.** Tiến độ, task, báo cáo, trí nhớ dự án nằm trong Git, không nằm trong lịch sử chat của agent.
4. **Vai trò tách khỏi người.** Dev, QC, PM là "ghế"; agent là "người ngồi ghế"; anh đổi được bất cứ lúc nào.
5. **Người code không tự test việc của mình.**
6. **Một project active tại một thời điểm**, mọi thao tác chỉ trong thư mục project đó.
7. **Không tự chuyển tài khoản** khi hết hạn mức. Hết Energy thì tạm dừng, chờ hồi hoặc anh đổi người ngồi ghế.

## 3. Thành viên và ghế

| Ghế | Mặc định | Công cụ | Nhiệm vụ |
|---|---|---|---|
| PM | Elon | Claude Code (`claude -p`) | Đọc spec, đề xuất thay đổi (OpenSpec), tách task, viết prompt, đọc báo cáo, ghi nhật ký, cập nhật trí nhớ, commit khi đạt |
| Dev | Jacky | Antigravity CLI (`agy -p`) | Hiện thực đúng thẻ task, thay đổi tối thiểu, commit, nộp báo cáo Dev |
| QC | Jenny | Codex CLI (`codex exec`) | Review diff, chạy unit test / TDD / E2E, đối chiếu tiêu chí nghiệm thu, nộp kết quả QC |

Luật từng ghế viết một lần trong `team/roles/{pm,dev,qc}.md`. File riêng của từng công cụ (`CLAUDE.md`, `AGENTS.md`, file rules của Antigravity) chỉ trỏ về đó.

## 4. Môi trường chạy

- Máy Ubuntu chuyên dev. BTM chạy như **systemd service** dưới user Linux riêng `agent`.
- User `agent` chỉ có quyền ghi trong thư mục projects (mặc định `/srv/agent-projects`).
- Dừng service = systemd dừng toàn bộ tiến trình con (agent không thể chạy ngầm sau khi BTM tắt).
- Dashboard lắng nghe `127.0.0.1`; anh xem qua `ssh -L 8080:localhost:8080 <user>@<host>` hoặc trình duyệt trong remote desktop.
- Ba CLI cài và đăng nhập **dưới user `agent`**. Không có biến môi trường API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).

## 5. Kiến trúc

```
 Anh ──(SSH tunnel)──► Dashboard (React, 127.0.0.1)
                            │  SSE trạng thái / POST lệnh
                            ▼
                    BTM Core (Node.js + TypeScript)
     ┌───────────────┬──────┴───────┬──────────────────┐
  Session &       Runner         Gate kiểm tra      Energy & Login
  Turn manager  (spawn CLI,     tự động (schema,    (đọc hạn mức,
  (khóa, lượt,   node-pty cho   scope, build,       sức khỏe
  hàng đợi)      agy, timeout)  lint, test)         đăng nhập)
     └───────────────┴──────┬───────┴──────────────────┘
                            ▼
              SQLite (vận hành)   +   Git repo của project (nội dung)
```

- **Core quyết định ai chạy**, PM chỉ trả về quyết định có cấu trúc (giao task nào, cho ghế nào, prompt ở file nào). PM không tự gọi Jacky hay Jenny.
- **Runner**: `child_process` cho `claude` và `codex`; `node-pty` cho `agy` (agy không in output khi stdout không phải TTY, và headless phải cấu hình quyền rõ ràng, nếu không thao tác bị từ chối ngầm mà vẫn báo thành công). Mỗi lượt có timeout; quá giờ thì dừng cả nhóm tiến trình.
- **Không tin chữ "done"**: sau mỗi lượt Core kiểm tra bằng chứng thật (commit tồn tại, diff, file trong scope, build).

## 6. Luồng làm việc

### 6.1 Lượt 0 – khởi tạo project

1. Anh đặt tên project (project thử nghiệm "Go to the Moon" tại `/srv/agent-projects/go-to-the-moon`). PM tạo `/srv/agent-projects/<tên>`, `git init`, `openspec init`, tạo `team/`, `docs/`, file vai trò, `.gitignore`, commit "init".
2. Core ghi project active vào SQLite (bảng `active_project`). Không có project active hợp lệ thì Runner từ chối chạy.

### 6.2 Một phiên

1. Anh mở phiên: nhập 1–3 tiêu đề mục tiêu, xác nhận đã kiểm tra Energy. Core chạy kiểm tra đăng nhập cả 3 ghế.
2. PM đọc `docs/`, `team/memory/`, đề xuất thay đổi bằng OpenSpec và tách thành thẻ task.
3. *(Tùy chọn, bật trong config)* Dừng cho anh duyệt danh sách thẻ task.
4. Core kiểm tra thẻ task đủ trường bắt buộc → commit trước lượt → gọi Dev.
5. Dev làm, commit, nộp báo cáo Dev, thoát.
6. **Gate tự động** (không tốn token AI): báo cáo đúng mẫu, commit tồn tại, diff không rỗng, file trong `scope`, build + lint đạt. Rớt → trả về Dev kèm lý do.
7. Core ghép prompt QC từ tiêu chí nghiệm thu + báo cáo Dev + mã commit → gọi QC.
8. QC trả kết quả theo từng tiêu chí. Đạt hết → PM commit/merge theo luật. Có tiêu chí rớt → trả Dev (tối đa N vòng sửa, quá thì dừng hỏi anh).
9. Hết mục tiêu hoặc hết lượt → PM viết báo cáo cuối phiên, cập nhật trí nhớ, phiên đóng.

### 6.3 Lệnh trực tiếp từ khung lệnh

- Mặc định gửi cho PM. Anh có thể gửi thẳng cho Dev hoặc QC (ví dụ "Jenny check phần A của Project B").
- Lệnh trực tiếp **xếp hàng sau lượt đang chạy**, không chạy chồng; PM vẫn ghi vào nhật ký.

## 7. Hợp đồng bàn giao

Mẫu đặt trong `team/templates/`. Core kiểm tra bằng schema (zod).

**Thẻ task** (front matter YAML trong `team/tasks/T-xxx.md`, liên kết với change của OpenSpec):

```yaml
id: T-015
openspec_change: add-otp-login
goal: API xác thực mã OTP
context: [docs/spec.md#otp, team/memory/conventions.md]
scope: [src/auth/otp.service.ts, src/auth/otp.controller.ts, tests/auth/]
out_of_scope: [giao diện, gửi email]
acceptance:
  - Mã đúng và còn hạn → trả về token
  - Mã sai → báo lỗi, đếm số lần sai
  - Sai 5 lần → khóa 15 phút
done_when: build đạt, test mới cho mọi tiêu chí đều pass
```

Luật: task vừa một lượt; quá nhiều tiêu chí hoặc nhiều module → PM phải tách. Dev được trả `BLOCKED` kèm câu hỏi thay vì đoán.

**Báo cáo Dev** (`team/reports/T-xxx-dev.md`): commit, file đã đổi, cách chạy, test đã thêm, hạn chế, bảng đối chiếu từng tiêu chí ↔ chỗ hiện thực.

**Kết quả QC** (`team/reports/T-xxx-qc.json`): `verdict` tổng, và với từng tiêu chí: `pass|fail`, bằng chứng (tên test, output), ghi chú over-engineering nếu có.

## 8. Energy và đăng nhập

- **Kiểm tra đăng nhập** khi mở phiên và trước mỗi lượt: còn đăng nhập, tài khoản đúng, không có biến API key đè. Trạng thái: `ok`, `sắp hết hạn`, `cần đăng nhập lại`.
- **Đọc hạn mức (chỉ đọc)**, tham khảo cách làm của Quota Station / quota-axi (MIT):
  - Antigravity: `agy -p /quota --output-format json` (chặn mở trình duyệt khi chạy).
  - Claude Code: dùng thông tin đăng nhập sẵn của Claude Code để đọc cửa sổ 5 giờ / tuần.
  - Codex: dùng `~/.codex/auth.json` (chỉ đọc) để đọc cửa sổ 5 giờ / tuần.
  - Hai cách sau dùng endpoint không công khai → có thể đổi bất cứ lúc nào; đọc thưa (khi mở phiên và trước mỗi lượt, có cache), không bao giờ ghi hay làm mới đăng nhập.
- Dưới ngưỡng Energy tối thiểu (config) → Core không giao lượt cho ghế đó, thẻ chuyển màu cam kèm giờ hồi.
- Hết hạn mức giữa lượt → Core commit WIP, ghi ghi chú tiến độ, task chuyển `chờ người nhận`.
- **Không** tự chuyển tài khoản, **không** xoay vòng nhiều tài khoản cùng một hãng.
- **Trang Tài khoản**: đăng nhập / đăng xuất từng CLI qua dashboard (BTM chỉ chuyển tiếp link xác thực và mã dùng một lần, không lưu). Cấm đăng nhập/đăng xuất khi ghế đó đang chạy.

## 9. Lớp an toàn

1. Không lịch chạy tự động, không vòng lặp nền.
2. Giới hạn lượt mỗi phiên (Core đếm).
3. Timeout mỗi lượt, dừng cả nhóm tiến trình.
4. Tối đa N vòng sửa mỗi task.
5. Nút **Dừng khẩn cấp**: dừng agent đang chạy, xóa hàng đợi, khóa phiên.
6. Commit Git trước mỗi lượt của Dev.
7. User Linux riêng, quyền ghi chỉ trong thư mục projects.
8. GitHub: fine-grained token chỉ cho repo project; Dev push nhánh task + mở PR; QC chỉ đọc/comment; `main` được bảo vệ (bắt buộc PR + test đạt). Token không bao giờ nằm trong repo.
9. Không lưu cookie phiên Google/NotebookLM trên máy chạy agent.

## 10. Khi một agent "nghỉ"

- Đăng nhập lỗi → thẻ đỏ, task của ghế đó chuyển `chờ người nhận`, dashboard báo anh. v1.0 **không tự bàn giao**.
- Anh chọn người ngồi tạm ghế. PM viết biên bản bàn giao từ ghi chú tiến độ + git log. Người thay đọc biên bản và diff trước khi sửa.
- Core chặn: agent đã code task nào thì không được QC task đó.
- Agent hồi phục → chỉ nhận task mới; task đang dở để người thay làm xong.
- "Đồ nghề theo ghế": agent nào có thể ngồi một ghế thì phải cài sẵn plugin/skill của ghế đó.

## 11. Dữ liệu và trí nhớ

**SQLite (vận hành, `better-sqlite3`)**: `active_project`, `sessions`, `turns` (ai, task, bắt đầu, kết thúc, kết quả, lỗi), `queue` (lệnh từ khung lệnh), `seats` (ghế ↔ agent), `agent_health`, `energy_readings`, `handoff_failures` (lý do bị trả về). Sau này: chỉ mục tìm kiếm toàn văn (FTS5) cho thư viện project.

**Git (nội dung)**:
- `docs/` – spec, kiến trúc, roadmap, `decisions/` (lý do các quyết định).
- `openspec/` – các change đang làm và đã lưu trữ.
- `team/memory/` – quy ước, bài học, thuật ngữ, tóm tắt giai đoạn. PM cập nhật cuối phiên, anh duyệt như duyệt code.

**Thư viện project**: cuối mỗi giai đoạn PM soạn "gói thư viện" (tóm tắt, kiến trúc, quyết định, bài học), anh duyệt rồi tự đưa lên NotebookLM. BTM không kết nối trực tiếp NotebookLM.

## 12. Plugin và skill (bật dần, đo hiệu quả bằng thống kê BTM)

| Bộ | Cấp | Ghế dùng | Ghi chú |
|---|---|---|---|
| OpenSpec | project | cả 3 | Xương sống spec; bật đầu tiên |
| Ponytail | agent | Dev (thường), QC (`review`) | Chống over-engineering; không dùng chế độ ultra |
| UI UX Pro Max | agent | Dev, QC khi task có giao diện | Cần Python |
| Superpowers | agent | PM, chọn lọc | Không dùng phần lập kế hoạch/brainstorm (trùng OpenSpec, dễ treo khi headless) |

Ghim phiên bản, đọc hook trước khi tin, cài dưới user `agent`.

## 13. Cấu trúc thư mục

```
btm/                          # repo của BTM
├─ btm.config.yaml
├─ docs/  spec.md  architecture.md  roadmap.md  decisions/
├─ src/
│  ├─ core/        session, turn, queue, seats
│  ├─ runner/      claude.ts, agy.ts (node-pty), codex.ts
│  ├─ gate/        schema, scope, build/lint/test
│  ├─ energy/      quota readers, login health
│  ├─ store/       SQLite + migrations
│  └─ server/      Fastify, SSE
└─ web/            dashboard React + Vite

/srv/agent-projects/<project>/   # repo của từng project
├─ docs/  openspec/
└─ team/  roles/  templates/  tasks/  prompts/  reports/  logs/  memory/
```

## 14. Dashboard v1.0

Thanh phiên (project active, phiên, lượt đã dùng, ai đang giữ lượt) · tiến độ mục tiêu · thẻ từng ghế (trạng thái, task, thời gian, dòng output cuối, Energy, đèn đăng nhập) · bảng task 5 cột · nhật ký PM · khung lệnh (chọn PM/Dev/QC) · nút Dừng khẩn cấp · trang Tài khoản · nút chuyển giao diện sáng/tối (mặc định theo hệ điều hành, nhớ lựa chọn trên trình duyệt).

## 15. Lộ trình

- **v1.0**: mọi mục ở trên, tối đa 1 agent chạy cùng lúc.
- **v1.1**: thống kê (lượt/task, tỷ lệ trả về, Energy), liên kết task ↔ spec, buổi phản biện có cấu trúc ở điểm đòn bẩy cao.
- **v2.0**: Git worktree cho từng task, 2–3 agent chạy song song (task khai báo `scope`, trùng thì xếp hàng), giao task cho ghế đang "sẵn sàng", PM nhận test có giới hạn.
- **v2.x**: PM gợi ý phân công, thư viện project tìm kiếm toàn văn.

## 16. Câu hỏi còn mở

1. Ai bấm merge vào `main`: anh hay PM sau khi QC đạt?
2. Stack của project đầu tiên (để viết quy trình test của QC).
3. Giá trị khởi đầu cho các thông số trong `btm.config.yaml` (đang để mức thận trọng).
4. Có dùng comment đánh dấu `ponytail:` trong quy ước code hay không.
