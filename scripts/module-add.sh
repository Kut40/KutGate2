#!/usr/bin/env bash
# Gate root script: module-add.sh <name>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=module-add
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

MODULE_RE='^[a-z][a-z0-9-]{1,31}$'
PROJECTS_ROOT=/srv/projects

[[ $# -eq 1 ]] || die "kullanım: module-add.sh <name>"
m="$1"
[[ "$m" =~ $MODULE_RE ]] || die "geçersiz modül adı"

grp="mod-$m"
dir="$PROJECTS_ROOT/$m"

if [[ -L "$PROJECTS_ROOT" ]]; then die "symlink reddedildi: $PROJECTS_ROOT"; fi
if [[ ! -d "$PROJECTS_ROOT" ]]; then
  mkdir -m 755 -- "$PROJECTS_ROOT"
fi
if [[ -L "$dir" ]]; then die "symlink reddedildi: $dir"; fi
if [[ -e "$dir" && ! -d "$dir" ]]; then die "dizin değil: $dir"; fi

if ! getent group "$grp" >/dev/null; then
  groupadd -- "$grp"
fi

if [[ ! -d "$dir" ]]; then
  mkdir -- "$dir"
fi
chgrp -- "$grp" "$dir"
chmod 2770 -- "$dir"

ok "module=$m"
