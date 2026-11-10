#!/usr/bin/env bash
# Cheki gửi 1 prompt file cho Victor/Qeen qua Antigravity CLI (agy), giữ hội thoại riêng từng người.
# Dùng: team/bin/agy-run.sh <victor|qeen> <prompt-file> [timeout-phút]
# Kết quả: team/runs/<YYYYmmdd-HHMM>-<người>-<tên prompt>.json ; id hội thoại: team/runs/<người>.conv
set -euo pipefail
who="$1"; prompt_file="$2"; tmin="${3:-25}"
case "$who" in victor|qeen) ;; *) echo "người phải là victor|qeen" >&2; exit 2;; esac
repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"
[ -f "$prompt_file" ] || { echo "không thấy $prompt_file" >&2; exit 2; }
export PATH="$PATH:$LOCALAPPDATA/agy/bin:/c/Users/$USERNAME/AppData/Local/agy/bin"
mkdir -p team/runs
# Không truyền token/API key của Cheki sang agent khác (BTM cũng từ chối chạy khi có các biến này).
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY

# agy 1.5.3 chỉ khớp NGUYÊN VĂN cả dòng lệnh (prefix/wildcard không chạy; "*" = cho tất cả → không dùng).
# Danh sách phải trùng team/prompts/rules-*.md. Không bao giờ --dangerously-skip-permissions.
allow='["command(git status)","command(git status --short)","command(git diff)","command(git diff --stat)","command(git log --oneline -10)","command(npx vitest run)","command(npx tsc --noEmit)"]'
settings="{\"permissions\":{\"allow\":$allow}}"

conv_file="team/runs/$who.conv"
conv_args=()
prompt="$(cat "$prompt_file")"
# Mặc định MỖI TASK 1 HỘI THOẠI MỚI (giữ 1 hội thoại dài đã đốt hết quota agy: ~265M token cache/lượt, 2026-11-10).
# Chỉ tiếp tục hội thoại cũ khi gọi với CONTINUE=1 (vd vòng fix ngay sau task, cần ngữ cảnh).
if [ "${CONTINUE:-0}" = "1" ] && [ -s "$conv_file" ]; then conv_args=(--conversation "$(cat "$conv_file")"); else prompt="$(cat "team/prompts/rules-$who.md")
$prompt"; fi
# Mỗi lượt nhắc lại: lệnh ngoài danh sách bị chặn và agy dừng CẢ lượt (đã mất 3 lượt vì git diff <file>, git grep).
prompt="NHẮC: terminal chỉ chạy được NGUYÊN VĂN: git status | git status --short | git diff | git diff --stat | git log --oneline -10 | npx vitest run | npx tsc --noEmit. Không thêm tham số, không git grep. Tìm/đọc file bằng công cụ tìm kiếm/đọc file của bạn. KHÔNG xoá test hay tính năng cũ (a11y, phím tắt, layout…) trừ khi prompt cho phép rõ – thay đổi giao diện thì viết lại test cho giao diện mới.

$prompt"

out="team/runs/$(date +%Y%m%d-%H%M)-$who-$(basename "$prompt_file" .md).json"
echo "$(date '+%F %T') · start $who · $prompt_file · $out" >> team/runs/runs.log
set +e
# stream-json: từng bước ghi ngay vào .stream.jsonl để xem trực tiếp (team/bin/watch.mjs); dòng "result" cuối = JSON cũ.
agy -p "$prompt" --effort "${AGY_EFFORT:-medium}" --mode accept-edits --settings "$settings" \
  --output-format stream-json --print-timeout "${tmin}m" "${conv_args[@]}" > "$out.stream.jsonl" 2> "$out.err"
rc=$?
set -e
node -e 'const fs=require("fs");const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");let r=null;for(const l of L){try{const j=JSON.parse(l);if(j.event==="result")r=j.result}catch{}}fs.writeFileSync(process.argv[2],JSON.stringify(r??{status:"NO_RESULT"}))' "$out.stream.jsonl" "$out" 2>/dev/null || true
# Lưu id hội thoại để lần sau V/Q nhớ ngữ cảnh.
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(j.conversation_id)require("fs").writeFileSync(process.argv[2],j.conversation_id)' "$out" "$conv_file" 2>/dev/null || true
status=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.status+" denied="+JSON.stringify(j.denied_actions||[]))}catch{console.log("no-json")}' "$out")
echo "$(date '+%F %T') · end $who · rc=$rc · $status" >> team/runs/runs.log
echo "rc=$rc $status → $out"
exit $rc
