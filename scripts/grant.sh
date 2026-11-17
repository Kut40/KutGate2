#!/usr/bin/env bash
# Gate root script: grant.sh <user> <module> <r|rw>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=grant
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
MODULE_RE='^[a-z][a-z0-9-]{1,31}$'
PROJECTS_ROOT=/srv/projects

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

[[ $# -eq 3 ]] || die "kullanım: grant.sh <user> <module> <r|rw>"
u="$1"
m="$2"
perm="$3"
check_user "$u"
[[ "$m" =~ $MODULE_RE ]] || die "geçersiz modül adı"
[[ "$perm" == "r" || "$perm" == "rw" ]] || die "geçersiz yetki (r|rw)"
has_acl=0
if command -v setfacl >/dev/null 2>&1; then has_acl=1; fi
if [[ "$perm" == "r" && "$has_acl" != "1" ]]; then die "acl paketi gerekli: apt install acl"; fi
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"

grp="mod-$m"
dir="$PROJECTS_ROOT/$m"
getent group "$grp" >/dev/null || die "grup yok: $grp"
if [[ -L "$PROJECTS_ROOT" || -L "$dir" ]]; then die "symlink reddedildi"; fi
[[ -d "$dir" ]] || die "modül dizini yok: $dir"

if [[ "$perm" == "rw" ]]; then
  gpasswd -a "$u" "$grp"
  if [[ "$has_acl" == "1" ]]; then
    setfacl -R -P -x "u:$u" -- "$dir"
    setfacl -R -P -d -x "u:$u" -- "$dir"
  fi
else
  if in_group "$u" "$grp"; then
    gpasswd -d "$u" "$grp"
  fi
  setfacl -R -P -m "u:$u:rX" -- "$dir"
  setfacl -R -P -d -m "u:$u:rX" -- "$dir"
fi

ok "user=$u module=$m perm=$perm"
