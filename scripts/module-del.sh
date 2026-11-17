#!/usr/bin/env bash
# Gate root script: module-del.sh <name>   (yalnızca grubu siler, veri kalır)
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=module-del
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

MODULE_RE='^[a-z][a-z0-9-]{1,31}$'

[[ $# -eq 1 ]] || die "kullanım: module-del.sh <name>"
m="$1"
[[ "$m" =~ $MODULE_RE ]] || die "geçersiz modül adı"

grp="mod-$m"
if getent group "$grp" >/dev/null; then
  groupdel -- "$grp"
fi

ok "module=$m"
