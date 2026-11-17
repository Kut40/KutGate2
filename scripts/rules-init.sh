#!/usr/bin/env bash
# Gate root script: rules-init.sh <user>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=rules-init
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
RULES_ROOT=/opt/claude-rules

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

[[ $# -eq 1 ]] || die "kullanım: rules-init.sh <user>"
u="$1"
check_user "$u"

src="$RULES_ROOT/users/_template"
dst="$RULES_ROOT/users/$u"

for p in "$RULES_ROOT" "$RULES_ROOT/users" "$src" "$dst"; do
  if [[ -L "$p" ]]; then die "symlink reddedildi: $p"; fi
done

# Varsa dokunma
if [[ -e "$dst" ]]; then
  ok "user=$u mevcut"
  exit 0
fi

[[ -d "$src" ]] || die "şablon yok: $src"

cp -R -P -- "$src" "$dst"
chown -R -P root:root -- "$dst"
chmod -R 755 -- "$dst"

ok "user=$u"
