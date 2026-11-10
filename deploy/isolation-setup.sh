#!/usr/bin/env bash
# Plan 4.5 – cách ly agent. Chạy bằng root (admzon: sudo bash deploy/isolation-setup.sh prep).
#   prep   : AN TOÀN chạy ngay – tạo user btm-worker, cài CLI cho worker, wrapper + sudoers, thư mục mới.
#            KHÔNG đổi quyền /srv/agent-projects, KHÔNG chuyển code BTM → service đang chạy không bị ảnh hưởng.
#   switch : (Task 6, chưa có) giao /srv/agent-projects cho btm-worker khi code Plan 4.5 đã deploy.
# Thêm --dry-run để chỉ in lệnh. Chạy lại nhiều lần vẫn an toàn.
set -euo pipefail

PHASE="${1:-}"; DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
W=btm-worker; G=btm-read; A=agent
PROJECTS=/srv/agent-projects; REPOS=/srv/btm-repos
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
  getent group "$G" >/dev/null || run groupadd "$G"
  id "$W" >/dev/null 2>&1 || run useradd -m -s /bin/bash "$W"
  run usermod -aG "$G" "$W"
  # Worker không được đọc home của agent (token CLI, code BTM cũ).
  run chmod 750 "/home/$A"

  run install -d -o "$A" -g "$G" -m 2750 "$REPOS"
  run install -d -o "$A" -g "$A" -m 755 /opt/btm

  # CLI riêng cho worker (cùng phiên bản), không dùng chung bản trong home agent.
  run install -d -o "$W" -g "$W" -m 755 "/home/$W/.npm-global" "/home/$W/.local" "/home/$W/.local/bin"
  run sudo -u "$W" -H npm install -g --prefix "/home/$W/.npm-global" \
    "@anthropic-ai/claude-code@$CLAUDE_VER" "@openai/codex@$CODEX_VER"
  run install -o "$W" -g "$W" -m 755 "/home/$A/.local/bin/agy" "/home/$W/.local/bin/agy"
  local line='export PATH=$HOME/.npm-global/bin:$HOME/.local/bin:$PATH'
  for f in .profile .bashrc; do
    grep -qsF "$line" "/home/$W/$f" || { [ "$DRY" = 1 ] && echo "+ thêm PATH vào /home/$W/$f" || echo "$line" >> "/home/$W/$f"; }
  done

  install_file /usr/local/bin/btm-worker-exec 755 <<'EOF'
#!/bin/bash
# Chạy 1 lệnh của agent/gate dưới btm-worker, chỉ trong /srv/agent-projects, env sạch.
set -euo pipefail
[ "$(id -un)" = btm-worker ] || { echo "phải chạy dưới btm-worker" >&2; exit 2; }
[ $# -ge 3 ] && [ "$2" = "--" ] || { echo "dùng: btm-worker-exec <cwd> -- <lệnh…>" >&2; exit 2; }
real="$(realpath -e -- "$1")"; shift 2
case "$real/" in /srv/agent-projects/|/srv/agent-projects/?*/) ;; *) echo "cwd ngoài /srv/agent-projects: $real" >&2; exit 2;; esac
cd "$real"
umask 022   # bundle do worker tạo phải đọc được bởi BTM (user agent)
keep=()
for v in CLAUDE_CONFIG_DIR CODEX_HOME AGY_ACCOUNT ANTIGRAVITY_GEMINI_DIR; do
  [ -n "${!v:-}" ] && keep+=("$v=${!v}")
done
exec env -i HOME=/home/btm-worker USER=btm-worker LOGNAME=btm-worker LANG=C.UTF-8 TERM=xterm-256color \
  PATH=/home/btm-worker/.npm-global/bin:/home/btm-worker/.local/bin:/usr/local/bin:/usr/bin:/bin \
  "${keep[@]}" "$@"
EOF

  install_file /usr/local/bin/btm-worker-killall 755 <<'EOF'
#!/bin/bash
# Giết mọi tiến trình của btm-worker (gọi sau mỗi lượt agent và mỗi lệnh gate). pkill tự loại chính nó.
[ "$(id -un)" = btm-worker ] || { echo "phải chạy dưới btm-worker" >&2; exit 2; }
exec pkill -KILL -u btm-worker
EOF

  # sudoers: agent chỉ được chạy đúng 2 wrapper dưới btm-worker, không mật khẩu.
  local sud; sud="$(mktemp)"
  cat > "$sud" <<'EOF'
Defaults!/usr/local/bin/btm-worker-exec env_keep += "CLAUDE_CONFIG_DIR CODEX_HOME AGY_ACCOUNT ANTIGRAVITY_GEMINI_DIR"
agent ALL=(btm-worker) NOPASSWD: /usr/local/bin/btm-worker-exec, /usr/local/bin/btm-worker-killall
EOF
  if [ "$DRY" = 1 ]; then echo "+ ghi /etc/sudoers.d/btm:"; sed 's/^/    /' "$sud"
  else visudo -cf "$sud" >/dev/null && install -o root -g root -m 440 "$sud" /etc/sudoers.d/btm; fi
  rm -f "$sud"

  echo
  echo "PREP xong. Kiểm: sudo -u $A sudo -n -u $W /usr/local/bin/btm-worker-killall; echo \$?   (0 hoặc 1 = OK)"
  echo "Đăng nhập CLI cho worker: xem docs/deploy-isolation.md"
}

switch() {
  # Hoàn thiện ở Task 6 cùng code Plan 4.5 (quyền đọc workspace/bundle cho BTM). Chưa chạy được.
  echo "switch chưa có – chờ code Plan 4.5 (Task 6)." >&2; exit 2
}

case "$PHASE" in
  prep) prep ;;
  switch) switch ;;
  *) echo "dùng: sudo bash $0 prep|switch [--dry-run]" >&2; exit 2 ;;
esac
