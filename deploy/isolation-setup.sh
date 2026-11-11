#!/usr/bin/env bash
# Plan 4.5 – cách ly agent, mỗi agent một user Linux riêng. Chạy bằng root (admzon: sudo bash deploy/isolation-setup.sh prep).
#   prep   : AN TOÀN chạy ngay – tạo user btm-<agent>, CLI dùng chung do root sở hữu (/opt/btm-cli), wrapper + sudoers,
#            /srv/btm-repos, /srv/btm-work/<user>. Không đụng service đang chạy.
#   switch : khoá thư mục dữ liệu BTM (700) + UMask=0027 cho btm.service. Không restart (anh restart).
# Thêm --dry-run để chỉ in lệnh. Chạy lại nhiều lần vẫn an toàn. Đổi danh sách agent: BTM_AGENTS="elon jacky jenny".
set -euo pipefail

PHASE="${1:-}"; DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
AGENTS="${BTM_AGENTS:-elon jacky jenny}"
A=agent; GR=btm-read; GW=btm-workers
REPOS=/srv/btm-repos; WORK=/srv/btm-work; CLI=/opt/btm-cli; DATA=/var/lib/btm
CLAUDE_VER=2.1.319; CODEX_VER=0.167.0   # cùng bản với user agent

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || { echo "Cần chạy bằng root: sudo bash $0 $PHASE" >&2; exit 1; }
id "$A" >/dev/null 2>&1 || { echo "Không thấy user $A" >&2; exit 1; }

install_file() { # install_file <đích> <mode>  (nội dung từ stdin)
  local dst="$1" mode="$2" tmp; tmp="$(mktemp)"; cat > "$tmp"
  if [ "$DRY" = 1 ]; then echo "+ ghi $dst ($mode):"; sed 's/^/    /' "$tmp"; rm -f "$tmp"; return; fi
  install -o root -g root -m "$mode" "$tmp" "$dst"; rm -f "$tmp"
}

prep() {
  for g in "$GR" "$GW"; do getent group "$g" >/dev/null || run groupadd "$g"; done
  # Agent không đọc được home của user agent (token CLI, code BTM).
  run chmod 750 "/home/$A"
  run install -d -o "$A" -g "$GR" -m 2750 "$REPOS"
  run install -d -o root -g root -m 755 "$WORK"

  # CLI do root sở hữu: agent (Dev) không sửa được file chạy mà QC/Audit dùng sau đó.
  run install -d -o root -g root -m 755 "$CLI" "$CLI/bin"
  run npm install -g --prefix "$CLI" "@anthropic-ai/claude-code@$CLAUDE_VER" "@openai/codex@$CODEX_VER"
  run install -o root -g root -m 755 "$(readlink -f "/home/$A/.local/bin/agy")" "$CLI/bin/agy"

  for id in $AGENTS; do
    local u="btm-$id"
    id "$u" >/dev/null 2>&1 || run useradd -m -s /bin/bash "$u"
    run usermod -aG "$GR,$GW" "$u"
    run chmod 700 "/home/$u"
    # Không cho cron/at/linger: tiến trình không sống sót qua killall sau lượt.
    for f in /etc/cron.deny /etc/at.deny; do
      grep -qsx "$u" "$f" || { [ "$DRY" = 1 ] && echo "+ thêm $u vào $f" || echo "$u" >> "$f"; }
    done
    run loginctl disable-linger "$u"
    run install -d -o "$u" -g "$u" -m 700 "$WORK/$u"
    local line="export PATH=$CLI/bin:\$PATH DISABLE_AUTOUPDATER=1"
    for f in .profile .bashrc; do
      grep -qsF "$line" "/home/$u/$f" || { [ "$DRY" = 1 ] && echo "+ thêm PATH vào /home/$u/$f" || echo "$line" >> "/home/$u/$f"; }
    done
  done

  install_file /usr/local/bin/btm-worker-exec 755 <<'EOF'
#!/bin/bash
# Chạy 1 lệnh của agent/gate dưới user btm-<agent>, chỉ trong home hoặc /srv/btm-work/<user>/, env sạch.
set -euo pipefail
u="$(id -un)"
case "$u" in btm-*) ;; *) echo "phải chạy dưới user btm-<agent>" >&2; exit 2;; esac
id -nG | tr ' ' '\n' | grep -qx btm-workers || { echo "$u không thuộc nhóm btm-workers" >&2; exit 2; }
[ $# -ge 3 ] && [ "$2" = "--" ] || { echo "dùng: btm-worker-exec <cwd> -- <lệnh…>" >&2; exit 2; }
home="$(getent passwd "$u" | cut -d: -f6)"
real="$(realpath -e -- "$1")"; shift 2
case "$real/" in "$home/"|"/srv/btm-work/$u/"|"/srv/btm-work/$u/"?*/) ;; *) echo "cwd không hợp lệ: $real" >&2; exit 2;; esac
cd "$real"
umask 077
exec env -i HOME="$home" USER="$u" LOGNAME="$u" LANG=C.UTF-8 TERM=xterm-256color DISABLE_AUTOUPDATER=1 \
  PATH=/opt/btm-cli/bin:/usr/local/bin:/usr/bin:/bin "$@"
EOF

  install_file /usr/local/bin/btm-worker-killall 755 <<'EOF'
#!/bin/bash
# Giết mọi tiến trình có real uid = user gọi, trừ chính script; lặp để bắt cả tiến trình vừa fork.
# Không dùng kill -1: nó trúng cả tiến trình sudo đang chạy script (saved uid = user đích).
case "$(id -un)" in btm-*) ;; *) echo "phải chạy dưới user btm-<agent>" >&2; exit 2;; esac
uid="$(id -u)"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pids=()
  for p in $(pgrep -U "$uid"); do [ "$p" != "$$" ] && pids+=("$p"); done
  [ ${#pids[@]} -eq 0 ] && exit 0
  kill -KILL "${pids[@]}" 2>/dev/null
  sleep 0.1
done
exit 3   # vẫn còn tiến trình sau 10 lần → BTM báo lỗi
EOF

  install_file /usr/local/bin/btm-worker-reset 755 <<'EOF'
#!/bin/bash
# Plan 5 Task 8: trước mỗi lượt (và trước gate), xoá cấu hình/hướng dẫn agent có thể tự cài vào home (git, npm,
# shell, CLI, MCP), dựng lại file shell từ mẫu. GIỮ đăng nhập: ~/.claude/.credentials.json, ~/.codex/auth.json,
# ~/.gemini/antigravity-cli/antigravity-oauth-token, installation_id; ~/.claude.json giữ nhưng bỏ mcpServers/allowedTools.
# Xoá không được (agent chmod) → thoát 3, BTM huỷ lượt.
set -u
case "$(id -un)" in btm-*) ;; *) echo "phải chạy dưới user btm-<agent>" >&2; exit 2;; esac
cd "$HOME" || exit 2
targets=(.gitconfig .config/git .npmrc .yarnrc .yarnrc.yml .bash_aliases .bash_profile .bash_login .bash_logout .local/bin
  .claude/CLAUDE.md .claude/settings.json .claude/settings.local.json .claude/commands .claude/agents
  .claude/hooks .claude/output-styles .claude/skills .claude/plugins .claude/projects
  .codex/config.toml .codex/AGENTS.md .codex/AGENTS.override.md .codex/prompts .codex/rules .codex/skills .agents
  .gemini/GEMINI.md .gemini/settings.json .gemini/extensions .gemini/commands
  .gemini/antigravity-cli/settings.json .gemini/config/mcp_config.json)
chmod -R u+rwX . 2>/dev/null
rm -rf -- "${targets[@]}"
for t in "${targets[@]}"; do [ -e "$t" ] || [ -L "$t" ] && { echo "không xoá được $t" >&2; exit 3; }; done
cp /etc/skel/.bashrc .bashrc && cp /etc/skel/.profile .profile || exit 3
echo 'export PATH=/opt/btm-cli/bin:$PATH DISABLE_AUTOUPDATER=1' | tee -a .bashrc >> .profile
if [ -f .claude.json ]; then
  python3 - <<'PY' || exit 3
import json, os
p = os.path.expanduser('~/.claude.json')
d = json.load(open(p))
d.pop('mcpServers', None)
for v in (d.get('projects') or {}).values():
    if isinstance(v, dict):
        for k in ('mcpServers', 'allowedTools', 'enabledMcpjsonServers', 'mcpContextUris'):
            v.pop(k, None)
tmp = p + '.btm-tmp'
with open(tmp, 'w') as f:
    json.dump(d, f)
os.chmod(tmp, 0o600)
os.replace(tmp, p)
PY
fi
exit 0
EOF

  # sudoers: agent chỉ được chạy đúng 3 wrapper dưới user thuộc nhóm btm-workers, không mật khẩu, không giữ env.
  local sud; sud="$(mktemp)"
  cat > "$sud" <<'EOF'
agent ALL=(%btm-workers) NOPASSWD: /usr/local/bin/btm-worker-exec, /usr/local/bin/btm-worker-killall, /usr/local/bin/btm-worker-reset
EOF
  if [ "$DRY" = 1 ]; then echo "+ ghi /etc/sudoers.d/btm:"; sed 's/^/    /' "$sud"
  else visudo -cf "$sud" >/dev/null && install -o root -g root -m 440 "$sud" /etc/sudoers.d/btm; fi
  rm -f "$sud"

  echo
  echo "PREP xong. Kiểm: sudo -u $A sudo -n -u btm-elon /usr/local/bin/btm-worker-killall; echo \$?   (0 = OK)"
  echo "Đăng nhập CLI cho từng user: xem docs/deploy-isolation.md"
}

switch() {
  # Dữ liệu BTM (btm.db, log) chỉ user agent đọc được; file mới BTM tạo không cho group ghi.
  run chmod 700 "$DATA"
  run install -d -o root -g root -m 755 /etc/systemd/system/btm.service.d
  printf '[Service]\nUMask=0027\n' | install_file /etc/systemd/system/btm.service.d/isolation.conf 644
  run systemctl daemon-reload
  echo
  echo "SWITCH xong (chưa restart). Tiếp theo: bật cách ly trong config + btm isolate – xem docs/deploy-isolation.md"
}

case "$PHASE" in
  prep) prep ;;
  switch) switch ;;
  *) echo "dùng: sudo bash $0 prep|switch [--dry-run]" >&2; exit 2 ;;
esac
