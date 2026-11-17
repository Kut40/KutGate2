#!/usr/bin/env bash
# Gate root script: portal-mode.sh <user> on|off|status
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=portal-mode
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
PORTAL_GROUP=gate-portal

is_protected() {
  local u="$1" f=/etc/gate/protected-users line uid
  if [[ "$u" == "root" ]]; then return 0; fi
  [[ -f "$f" && ! -L "$f" && "$(stat -c %u -- "$f")" == "0" ]] || die "korunan kullanıcı dosyası geçersiz: $f"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line//[[:space:]]/}"
    if [[ -n "$line" && "$line" == "$u" ]]; then return 0; fi
  done < "$f"
  if uid="$(id -u "$u" 2>/dev/null)"; then
    if (( uid < 1000 )); then return 0; fi
  fi
  return 1
}

check_user() {
  if [[ ! "$1" =~ $USER_RE ]]; then die "geçersiz kullanıcı adı"; fi
  if is_protected "$1"; then die "korunan hesap: $1"; fi
  return 0
}

in_group() {
  local g
  for g in $(id -nG "$1"); do
    if [[ "$g" == "$2" ]]; then return 0; fi
  done
  return 1
}

[[ $# -eq 2 ]] || die "kullanım: portal-mode.sh <user> on|off|status"
u="$1"
action="$2"
check_user "$u"
case "$action" in
  on|off|status) ;;
  *) die "geçersiz işlem (on|off|status)" ;;
esac
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"

if ! getent group "$PORTAL_GROUP" >/dev/null; then
  groupadd -- "$PORTAL_GROUP"
fi

case "$action" in
  on)
    if ! in_group "$u" "$PORTAL_GROUP"; then
      gpasswd -a "$u" "$PORTAL_GROUP"
    fi
    pkill -KILL -u "$u" sshd || true
    ok "user=$u action=on"
    ;;
  off)
    if in_group "$u" "$PORTAL_GROUP"; then
      gpasswd -d "$u" "$PORTAL_GROUP"
    fi
    ok "user=$u action=off"
    ;;
  status)
    if in_group "$u" "$PORTAL_GROUP"; then st=true; else st=false; fi
    log "ok user=$u action=status portalMode=$st"
    printf '{"ok":true,"portalMode":%s}\n' "$st" >&3
    ;;
esac
