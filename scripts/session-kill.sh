#!/usr/bin/env bash
# Gate root script: session-kill.sh <unit>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=session-kill
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

UNIT_RE='^gate-portal-([a-z][a-z0-9_-]{1,31})-[a-f0-9]{24}$'
USER_RE='^[a-z][a-z0-9_-]{1,31}$'

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

[[ $# -eq 1 ]] || die "kullanım: session-kill.sh <unit>"
unit="$1"
[[ "$unit" =~ $UNIT_RE ]] || die "geçersiz unit adı"
check_user "${BASH_REMATCH[1]}"

systemctl kill --signal=SIGKILL -- "$unit.service" || true
systemctl stop -- "$unit.service" || true

ok "unit=$unit"
