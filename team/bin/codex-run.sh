#!/usr/bin/env bash
# Cheki giao 1 prompt cho Codex ngồi tạm ghế của Victor/Qeen (khi agy hết quota).
# Dùng: team/bin/codex-run.sh <victor|qeen> <prompt-file> [timeout-phút]
# Kết quả: team/runs/<YYYYmmdd-HHMM>-codex-<ghế>-<tên prompt>.json(.stream.jsonl) ; log: team/runs/runs.log
set -euo pipefail
seat="$1"; prompt_file="$2"; tmin="${3:-40}"
case "$seat" in victor|qeen) ;; *) echo "ghế phải là victor|qeen" >&2; exit 2;; esac
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
[ -f "$prompt_file" ] || { echo "không thấy $prompt_file" >&2; exit 2; }
mkdir -p team/runs
# Codex phải dùng login ChatGPT, không API key; không mang token của Cheki sang.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY CODEX_API_KEY

prompt="Bạn là Codex, ngồi TẠM ghế $seat (agent cũ hết quota). Làm đúng luật dưới đây.
NHẮC: chỉ chạy các lệnh: git status | git status --short | git diff | git diff --stat | git log --oneline -10 | npx vitest run | npx tsc --noEmit (và đọc/tìm file). KHÔNG commit, không đổi nhánh, không cài gói, không mạng. KHÔNG xoá test hay tính năng cũ trừ khi prompt cho phép rõ.
Môi trường: Windows, Git Bash/PowerShell. File mới/viết lại dùng LF.

$(cat "team/prompts/rules-$seat.md")

$(cat "$prompt_file")"

out="team/runs/$(date +%Y%m%d-%H%M)-codex-$seat-$(basename "$prompt_file" .md).json"
echo "$(date '+%F %T') · start codex($seat) · $prompt_file · $out" >> team/runs/runs.log
set +e
# ~/.codex của Zon có thể trỏ proxy riêng (model_provider=custom, 127.0.0.1:8045) → mặc định dùng thẳng login ChatGPT (openai).
# Model mặc định: gpt-6-luna (Zon 2026-11-10; cần Codex ≥ 0.167; gpt-6.1-* không dùng được với login ChatGPT).
# Sandbox Windows "elevated" (mặc định máy này) đòi UAC mỗi lệnh → lỗi 1223; "unelevated" không cần admin.
# workspace-write: chỉ ghi trong repo, không mạng. Không bao giờ --dangerously-bypass-*.
# Test ghi repo tạm vào %TEMP% → cho ghi thêm thư mục đó.
timeout "${tmin}m" codex exec -c model_provider="\"${CODEX_PROVIDER:-openai}\"" -m "${CODEX_MODEL:-gpt-6-luna}" -c model_reasoning_effort="\"${CODEX_EFFORT:-medium}\"" -c windows.sandbox="\"unelevated\"" -s workspace-write -C "$repo" --add-dir "$(cygpath -w "${TEMP:-/tmp}")" --json -o "$out.last.md" - <<< "$prompt" \
  > "$out.stream.jsonl" 2> "$out.err"
rc=$?
set -e
echo "$(date '+%F %T') · end codex($seat) · rc=$rc · $(tail -c 300 "$out.last.md" 2>/dev/null | tr '\n' ' ')" >> team/runs/runs.log
echo "rc=$rc → $out.last.md"
exit $rc
