# BTM – Kế hoạch 4.5: Cách ly agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cách chạy ở dự án này:** Cheki giao Dev (Victor/agy hoặc Codex ngồi ghế Victor) qua `team/bin/*-run.sh` + `team/board.md`; reviewer độc lập kiểm; Cheki test VM, commit. Nhánh `plan4-5-isolation` tạo từ `main` **sau khi Plan 4 merge**. Làm TRƯỚC Plan 5 và trước dự án thật (anh Zon 2026-11-10).

**Goal:** Agent và lệnh gate không còn ghi được bất cứ thứ gì BTM tin (code BTM, `btm.db`, nhánh main, cấu hình git BTM dùng), nên guard không phải vá từng lỗ nữa.

**Architecture:** Hai user Linux. `agent` (đã có) chạy service BTM, sở hữu code BTM (`/opt/btm`), `data_dir` và **repo tin cậy** (bare, `/srv/btm-repos/<project>.git`, chứa main thật). User mới `btm-worker` chạy mọi CLI agent và mọi lệnh gate trong **workspace** `/srv/agent-projects/<project>` (worker sở hữu). Sau mỗi lượt, worker đóng `git bundle` nhánh goal; BTM chỉ `fetch` từ bundle (dữ liệu thuần, không chạy config/hook của worker) vào repo tin cậy, rồi mọi kiểm tra (gate ticket/scope/tamper, approve, merge) chạy trên repo tin cậy. Hết lượt: giết mọi tiến trình của `btm-worker`.

**Tech Stack:** như Kế hoạch 1–4; `sudo` (luật hẹp) + `git bundle`.

**Spec:** `team/reviews/P4-review-4.md` (D1 D2 D5) + quyết định anh Zon 2026-11-10 (team/log.md) + `docs/spec.md` §2, §4.

## Đổi thiết kế (Cheki, 2026-11-10, sau Task 4a)

Repo tin cậy là **bản checkout thường** (không bare) do BTM sở hữu: `/srv/btm-repos/<project>`. Đây là "project" trong store; mọi logic Plan 4 (session, guard, gate kiểm git, commit của BTM, approve) chạy NGUYÊN như cũ trên nó. Agent không bao giờ chạy trong đó.
- **Runner** (bật isolation): trước lượt, worker đồng bộ workspace `<projects_root>/<tên>` về đúng nhánh + sha hiện tại của checkout tin cậy (`syncWorkspace`); agent chạy trong workspace; sau lượt (kể cả lỗi/timeout), worker `git add -A` + commit tạm `btm-turn` (--allow-empty) rồi đóng bundle đúng nhánh đó; BTM nhập bundle vào checkout tin cậy (`checkout -f -B <nhánh> <sha nhập>`), bỏ commit tạm bằng `reset --soft HEAD~1` → thay đổi của agent nằm trong checkout tin cậy như khi agent chạy trực tiếp, guard/gate/commitAll Plan 4 xử lý tiếp như cũ. Bundle hỏng/sai ref → lượt coi như lỗi (exitCode ≠ 0, lý do `bundle_invalid`/`bundle_wrong_ref` trong output).
- **Gate**: lệnh build/lint/test chạy trong workspace dưới worker sau khi đồng bộ workspace về HEAD của checkout tin cậy; phần kiểm git của gate chạy trên checkout tin cậy như cũ.
- `approveGoal`: dùng lại đường merge cũ trên checkout tin cậy (bỏ nhánh merge-tree bare của 4a).
- Thay Task 4 bằng: 4b (trusted checkout + approve), 4c (runner + gate). Host lệnh trực tiếp đi qua runner nên tự có.

## Global Constraints

- `btm-worker` KHÔNG ghi được: `/opt/btm`, `/var/lib/btm`, `/srv/btm-repos`, `/home/agent`. Đọc được `/srv/btm-repos` (nhóm `btm-read`, chỉ đọc) để lấy main.
- BTM (user `agent`) không bao giờ chạy git TRONG workspace của worker với config của worker; chỉ đọc bundle do worker tạo. Mọi git của BTM vẫn qua `src/git.ts` (giữ `-c` an toàn, `GIT_CONFIG_GLOBAL=/dev/null`, `safe.directory`).
- Luật sudo duy nhất (do anh Zon cài bằng `admzon`): `agent ALL=(btm-worker) NOPASSWD: /usr/local/bin/btm-worker-exec, /usr/local/bin/btm-worker-killall`. Không cho shell tự do.
- Không API key (như cũ). Đăng nhập CLI (claude/codex/agy) chuyển sang home của `btm-worker` (anh đăng nhập lại 1 lần).
- `host.worker_user` không đặt (Windows/test) → chạy như hiện tại (không sudo, không bundle) – để test và máy dev vẫn chạy được. Chỉ VM bật.
- Test không gọi sudo thật: runner/importer nhận hàm `exec` giả. `npx vitest run` không tăng fail; `npx tsc --noEmit` sạch.

## Review Focus

1. **Tiến trình nền của worker sống sau lượt/gate** (nohup, setsid, `&`) → `btm-worker-killall` sau mỗi lượt và mỗi lệnh gate; lượt sau không còn tiến trình nào của worker. (Task 2)
2. **Bundle độc** (ref lạ, `refs/replace/*`, tag, nhánh main, rỗng, hỏng) → importer chỉ nhận đúng `refs/heads/goal/G<n>-*` của goal đang chạy vào `refs/btm/incoming/G<n>`; còn lại bỏ, bundle hỏng → lượt `rejected` `bundle_invalid`. (Task 3)
3. **Worker sửa main trong workspace** → không ảnh hưởng: main thật ở repo tin cậy; workspace main bị ghi đè từ repo tin cậy đầu mỗi lượt. (Task 3, 4)
4. **Anh merge tay / pull** → anh thao tác trên repo tin cậy (hoặc `btm main accept` như Plan 4); workspace tự đồng bộ lượt sau. (Task 4)
5. **Deploy dở dang** (đã có user nhưng chưa chuyển login CLI) → đèn đăng nhập đỏ, phiên không chạy, không crash. (Task 5)

---

## File Structure

- Create `deploy/isolation-setup.sh` – script root (anh chạy bằng `admzon`): tạo user/nhóm, thư mục, quyền, 2 wrapper `/usr/local/bin/btm-worker-exec|killall`, sudoers.
- Create `src/isolation/worker.ts` – chạy lệnh dưới worker (`workerExec`), giết hết (`workerKillAll`).
- Create `src/isolation/trusted.ts` – repo tin cậy: tạo, nhập bundle, đồng bộ workspace.
- Modify `src/config.ts` (`host.worker_user?`, `host.trusted_root?`), `src/runner/run.ts`, `src/gate/gate.ts`, `src/core/session.ts`, `src/server/host.ts`, `src/ticket/goal.ts`, `src/project/init.ts`, `src/project/migrate.ts`, `src/energy/*` (đọc Energy/login dưới worker).
- Modify `docs/spec.md` §2 §4, `btm.config.yaml`, Create `docs/deploy-isolation.md`.

---

### Task 1: Hạ tầng VM (script + tài liệu)

**Files:** Create `deploy/isolation-setup.sh`, `docs/deploy-isolation.md`.

- Script idempotent, `set -euo pipefail`, chỉ chạy khi `id -u` = 0: tạo user `btm-worker` (không sudo, shell `/bin/bash`), nhóm `btm-read` (thành viên `btm-worker`); `/opt/btm` (agent:agent 0755), `/srv/btm-repos` (agent:btm-read 0750, repo 0750 g+r), `/var/lib/btm` (agent 0700), `/srv/agent-projects` → owner `btm-worker` 0750 + ACL đọc cho `agent`; cài 2 wrapper (root:root 0755):
  - `btm-worker-exec <cwd> -- <argv…>`: `cd`, `env -i` + danh sách trắng biến (PATH, HOME=/home/btm-worker, LANG, TERM, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `AGY_ACCOUNT`, `ANTIGRAVITY_GEMINI_DIR`), từ chối cwd ngoài `/srv/agent-projects/`.
  - `btm-worker-killall`: `pkill -KILL -u btm-worker; exit 0`.
  - sudoers drop-in `/etc/sudoers.d/btm` đúng 1 dòng ở Global Constraints, `visudo -c` trước khi ghi.
- `docs/deploy-isolation.md` (≤1 trang): thứ tự chạy, chuyển code BTM sang `/opt/btm`, sửa `btm.service` (`WorkingDirectory=/opt/btm`), đăng nhập lại 3 CLI dưới `btm-worker`, cách quay lui.
- [ ] **Step 1:** `bash -n deploy/isolation-setup.sh`; Cheki chạy thử trên VM ở chế độ `--dry-run` (in lệnh, không làm) và gửi anh Zon. **Step 2:** Commit `chore: isolation setup script and runbook (P4.5 Task 1)`.

### Task 2: Runner + gate chạy dưới worker

**Files:** Create `src/isolation/worker.ts`; Modify `src/config.ts`, `src/runner/run.ts`, `src/gate/gate.ts`; tests `tests/worker.test.ts`, `tests/run.test.ts`, `tests/gate.test.ts`.

**Interfaces – Produces:**
- `HostSchema` thêm `worker_user?: string` (`/^[a-z_][a-z0-9_-]{0,31}$/`), `trusted_root?: string` (tuyệt đối).
- `wrapForWorker(cfg: Config, argv: string[], cwd: string): string[]` – không `worker_user` → `argv` nguyên; có → `['sudo','-n','-u',user,'/usr/local/bin/btm-worker-exec',cwd,'--',...argv]`.
- `workerKillAll(cfg: Config, exec?: ExecFn): void` – không `worker_user` → không làm gì.
- Runner: argv qua `wrapForWorker`; sau mỗi lượt (kể cả timeout/abort/lỗi) gọi `workerKillAll`. Gate: mỗi lệnh gate qua `wrapForWorker` + `workerKillAll` sau từng lệnh.
- [ ] **Step 1: Test:** có `worker_user` → argv bắt đầu đúng `sudo -n -u btm-worker /usr/local/bin/btm-worker-exec <cwd> --`; không có → giữ nguyên; `workerKillAll` được gọi sau lượt thành công, timeout và abort; gate gọi killall sau từng lệnh; tên user sai định dạng → config lỗi.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: run agents and gate as worker user (P4.5 Task 2)`.

### Task 3: Repo tin cậy + nhập bundle

**Files:** Create `src/isolation/trusted.ts`; tests `tests/trusted.test.ts`.

**Interfaces – Produces:**
- `trustedRepoPath(cfg: Config, project: string): string` = `<trusted_root>/<basename(project)>.git`.
- `ensureTrustedRepo(cfg, project): string` – chưa có → `git clone --bare --no-local <workspace>` lần đầu (do BTM chạy, chỉ khi bắt đầu dùng isolation); trả path.
- `importGoalBundle(cfg, project, goal: { n: number; branch: string }, exec?: ExecFn): { ok: true; sha: string } | { ok: false; reason: 'bundle_invalid' | 'bundle_wrong_ref' }` – worker chạy `git bundle create <tmp>/G<n>.bundle refs/heads/<branch>` (qua `wrapForWorker`); BTM `git bundle verify` + `git bundle list-heads`: đúng 1 head = `refs/heads/<branch>`, không thì từ chối; `git fetch <bundle> refs/heads/<branch>:refs/btm/incoming/G<n>` trong repo tin cậy; xoá bundle.
- `syncWorkspace(cfg, project, ref: string, exec?)` – worker: `git fetch <trusted> +refs/heads/*:refs/remotes/trusted/*` rồi `git checkout -f -B <nhánh> <sha>` (qua `wrapForWorker`).
- [ ] **Step 1: Test** (repo thật trong tmp, `exec` giả chạy trực tiếp): bundle đúng → sha khớp, ref `refs/btm/incoming/G1`; bundle có thêm `refs/heads/main` hoặc `refs/replace/x` → `bundle_wrong_ref`, repo tin cậy không đổi; file hỏng → `bundle_invalid`; workspace main bị sửa → sau `syncWorkspace` main workspace = main tin cậy.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: trusted repo and bundle import (P4.5 Task 3)`.

### Task 4: Session/host/approve dùng repo tin cậy

**Files:** Modify `src/core/session.ts`, `src/server/host.ts`, `src/ticket/goal.ts`, `src/project/init.ts`, `src/project/migrate.ts`; tests `tests/session.test.ts`, `tests/host.test.ts`, `tests/goal.test.ts`.

- Khi bật isolation: đầu mỗi lượt `syncWorkspace` về sha goal trong repo tin cậy; sau lượt pm/dev → `importGoalBundle`, cập nhật `refs/heads/<goal branch>` trong repo tin cậy CHỈ sau khi gate (commit id, scope, ticket_tampered – chạy trên repo tin cậy, base..incoming) đạt; qc/audit: không nhập bundle (không được commit).
- `approveGoal` merge trong repo tin cậy (main ở đó); `protected_sha` ghim theo repo tin cậy. Workspace main chỉ là bản sao.
- `init`/`migrate`: tạo repo tin cậy khi `worker_user` có.
- Guard Plan 4 giữ nguyên làm lớp phụ (không xoá ở plan này).
- [ ] **Step 1: Test:** lượt dev sửa main + `.git/config` trong workspace → main tin cậy không đổi, lượt sau workspace bị ghi đè sạch; commit thiếu ticket id trong bundle → bị từ chối, nhánh goal tin cậy không đổi; approve merge vào main tin cậy; không bật isolation → toàn bộ test cũ vẫn xanh.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: sessions use trusted repo when isolated (P4.5 Task 4)`.

### Task 5: Energy/login dưới worker + tài liệu

**Files:** Modify `src/energy/*.ts`, `docs/spec.md` §2 §4, `btm.config.yaml`; tests `tests/login.test.ts`, `tests/quota.test.ts`.

- Lệnh đọc Energy/đăng nhập chạy qua `wrapForWorker`; CLI chưa đăng nhập dưới worker → `relogin`, lệnh đăng nhập gợi ý `sudo -iu btm-worker <cli> login`.
- `btm.config.yaml`: `worker_user: btm-worker`, `trusted_root: /srv/btm-repos` (comment: Windows/dev bỏ trống).
- [ ] **Step 1: Test:** có `worker_user` → lệnh đọc quota bắt đầu bằng sudo wrapper; output "not logged in" → `relogin` với lệnh gợi ý đúng user.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: energy and login under worker user (P4.5 Task 5)`.

### Task 6: Triển khai VM + kiểm thật (Cheki + anh Zon)

- Anh chạy `deploy/isolation-setup.sh` bằng `admzon`; Cheki chuyển code sang `/opt/btm`, sửa service (anh đồng ý restart), anh đăng nhập lại 3 CLI dưới `btm-worker`.
- Kiểm thật trên project demo: agent thử `git update-ref refs/heads/main`, sửa `.git/config`, `nohup sleep 999 &`, ghi `/var/lib/btm/x` → main tin cậy không đổi, `ps -u btm-worker` rỗng sau lượt, ghi `/var/lib/btm` bị từ chối.
- Ghi kết quả `team/log.md`; review độc lập toàn nhánh trước khi anh merge.

---

## Để sau

Bỏ phần guard Plan 4 đã thừa (sau 1 thời gian chạy ổn); container/namespace thay cho user riêng; push GitHub từ repo tin cậy (deploy key chỉ BTM giữ).
