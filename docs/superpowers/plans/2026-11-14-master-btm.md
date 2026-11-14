# Boss (MB) – kế hoạch làm

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Native – Cheki làm). Bước dùng `- [ ]`.

**Goal:** Thêm thành viên Boss (`mb`): Claude Code chạy model GLM qua Z.ai, key mã hoá trong DB, agent chỉ cầm mã tạm của lượt.
**Architecture:** `src/mb/` có kho key (AES-256-GCM, khoá giải mã trong file) và cổng trung gian 127.0.0.1 thay mã tạm bằng key thật. Agent có `provider: zai` được runner bọc `env ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=<mã tạm>`; monitor không đọc quota/đăng nhập CLI mà hỏi kho key.
**Tech Stack:** TypeScript, `node:crypto`, `node:http`/`node:https` (không thêm thư viện), vitest.
**Spec:** `docs/superpowers/specs/2026-11-14-master-btm-design.md` · Quyết định `docs/decisions/0003-master-btm-api-key.md`

## Global Constraints
- Key thật không bao giờ: trả qua API, ghi log, nằm trong argv/env của agent, nằm trong git.
- `login.forbidden_env` giữ nguyên (kiểm env của BTM); chỉ argv của lượt Boss có `ANTHROPIC_AUTH_TOKEN=<mã tạm>`.
- Base URL `https://api.z.ai/api/anthropic`; model `glm-5.3` (mặc định), `glm-5.3-flash` (đã thử thật 2026-11-14).
- Boss = worker: không thêm quyền; luật coder_cannot_qc_same_task giữ.
- POST cần header `x-btm: 1`; UI dùng textContent.

## Review Focus
- Mã tạm sai / hết hạn / Boss bị tắt → cổng trả 401, không gọi Z.ai.
- Khoá giải mã đổi/mất → không giải mã được → Boss "relogin" (không crash).
- Key dán có khoảng trắng/xuống dòng thừa → cắt; key rỗng/quá ngắn → 400.
- Lượt lỗi/timeout → mã tạm vẫn bị thu hồi (finally).
- Phản hồi stream (SSE) của Z.ai phải chuyển nguyên, không gom.

---

### Task 1: Kho key `src/mb/vault.ts`
- Tạo: `encryptKey(plain, master: Buffer) → {iv, tag, data, last4}`, `decryptKey(rec, master) → string | null` (sai khoá → null).
- `loadMasterKey(dataDir) → Buffer`: `<dataDir>/keys/master.key` 32 byte; thiếu thì tạo (dir 0700, file 0600).
- `saveMbKey(store, dataDir, plain)`, `readMbKey(store, dataDir) → string | null`, `mbStatus(store) → { set, last4, enabled }`, `setMbEnabled(store, on)`, `removeMbKey(store)`. Setting: `mb_key` (JSON bản mã), `mb_enabled` ('1'/'0', mặc định bật khi vừa lưu key).
- `cleanKey(s) → string | null`: trim; 20–300 ký tự in được, không khoảng trắng.
- Test `tests/mb.test.ts`: mã hoá ↔ giải mã; khoá khác → null; DB không chứa key thật; cleanKey.

### Task 2: Cổng trung gian `src/mb/proxy.ts`
- `issueTurnToken(ttlMs) → string`, `revokeTurnToken(t)`, `startMbProxy({ store, dataDir, port = 8099, upstream = ZAI_BASE_URL }) → http.Server`.
- Yêu cầu: `Authorization: Bearer <mã>` hoặc `x-api-key`; mã hợp lệ + Boss bật + có key → gọi upstream (thay header auth bằng key thật, host = upstream), pipe phản hồi nguyên; ngược lại 401 JSON.
- Test: 401 khi không mã / mã thu hồi / tắt; 200 qua upstream giả (server test) và upstream nhận đúng key thật; client không bao giờ thấy key thật.

### Task 3: Agent Boss
- `config.ts`: `AgentConfigSchema.provider: z.literal('zai').optional()`; refine: zai chỉ với `tool: claude-code`.
- `models.ts`: `ZAI_MODELS = ['glm-5.3', 'glm-5.3-flash']`; `listModels(tool, run, provider?)`.
- `runner/run.ts`: provider zai → `issueTurnToken`, argv = `['env', 'ANTHROPIC_BASE_URL=http://127.0.0.1:<port>', 'ANTHROPIC_AUTH_TOKEN=<mã>', 'API_TIMEOUT_MS=3000000', 'DISABLE_TELEMETRY=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', ...argv]`; thu hồi trong `finally`. Model mặc định `glm-5.3` nếu chưa chọn.
- `energy/monitor.ts`: provider zai → energy `unknown` (note "Z.ai"), đăng nhập theo `mbStatus` (`ok` / `relogin` "Set Boss key"), model = ZAI_MODELS.
- `core/session.ts backupsFor`: thêm cuối danh sách mọi agent zai có ghế đó trong can_sit.
- Test: config refine; argv có env + mã, không có key thật; backupsFor có mb cuối; monitor không chạy CLI cho mb.

### Task 4: API + dashboard
- `POST /api/mb` `{ action: 'set'|'enable'|'disable'|'remove', key? }` → `mbStatus`; snapshot `settings.mb = mbStatus`.
- `host`/`serve`: khởi động cổng trung gian cùng BTM.
- UI (trang Accounts): thẻ "Boss key (Z.ai)": ô password + Lưu, hiện `…last4`, nút Tắt/Bật, Xoá. Thẻ agent: ID mờ cạnh tên; Boss có nhãn "Backup · all seats".
- Test: API không trả key; thiếu x-btm → 403; key rỗng → 400; web có ô + chuỗi i18n.

### Task 5: Kiểm + VM
- Test local, VM ×3, PR, merge.
- Anh Zon duyệt rồi mới làm trên VM: tạo user `btm-mb` (`deploy/isolation-setup.sh prep` với `BTM_AGENTS=mb`), thêm agent `mb` vào btm.config.yaml trên VM, deploy, anh dán key vào thẻ Boss, chạy thử một lượt Dev nhỏ trên project test.
