#!/usr/bin/env bash
# Gate root script: dev-changes.sh <user> <since_epoch>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=dev-changes
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
MODULE_RE='^[a-z][a-z0-9-]{1,31}$'
SINCE_RE='^[0-9]{1,12}$'
PROJECTS_ROOT=/srv/projects
MAX_FILES=50

# Sabit kod (kullanıcı girdisi içermez): stdin'deki NUL ayrılmış göreli yolları güvenli JSON nesnesine çevirir.
# Proje adı argüman olarak verilir; geçersiz UTF-8 içeren adlar atlanır.
PY_PROJECT='import sys, json
names = []
count = 0
for raw in sys.stdin.buffer.read().split(b"\0"):
    if not raw:
        continue
    try:
        s = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        continue
    count += 1
    if len(names) < int(sys.argv[2]):
        names.append(s)
sys.stdout.write(json.dumps({"name": sys.argv[1], "count": count, "files": names}, ensure_ascii=True, separators=(",", ":")))
'

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

has_read_acl() {
  local d="$1" u="$2" line
  while IFS= read -r line; do
    if [[ "$line" == "user:$u:r-x" || "$line" == "user:$u:r-x"[[:space:]]* ]]; then return 0; fi
  done < <(getfacl --absolute-names --omit-header --physical -- "$d" 2>/dev/null || true)
  return 1
}

[[ $# -eq 2 ]] || die "kullanım: dev-changes.sh <user> <since_epoch>"
u="$1"
since="$2"
check_user "$u"
[[ "$since" =~ $SINCE_RE ]] || die "geçersiz since_epoch"
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"
command -v python3 >/dev/null 2>&1 || die "python3 bulunamadı"
cd /

projects=()
if [[ -L "$PROJECTS_ROOT" ]]; then die "symlink reddedildi: $PROJECTS_ROOT"; fi
if [[ -d "$PROJECTS_ROOT" ]]; then
  for d in "$PROJECTS_ROOT"/*; do
    if [[ -L "$d" || ! -d "$d" ]]; then continue; fi
    name="${d##*/}"
    if [[ ! "$name" =~ $MODULE_RE ]]; then continue; fi
    if getent group "mod-$name" >/dev/null && in_group "$u" "mod-$name"; then
      projects+=("$name")
    elif has_read_acl "$d" "$u"; then
      projects+=("$name")
    fi
  done
fi

out='{"ok":true,"projects":['
n=0
for name in "${projects[@]}"; do
  dir="$PROJECTS_ROOT/$name"
  obj="$( { find -P "$dir" -xdev -type f -newermt "@$since" -not -path '*/.git/*' -not -path '*/node_modules/*' -printf '%P\0' 2>/dev/null || true; } | sort -z | python3 -I -c "$PY_PROJECT" "$name" "$MAX_FILES" )" || die "proje taranamadı: $name"
  [[ "$obj" == '{"name":'* && "$obj" == *'}' ]] || die "geçersiz çıktı: $name"
  if (( n > 0 )); then out+=","; fi
  out+="$obj"
  n=$((n + 1))
done
out+=']}'

log "ok user=$u since=$since projects=$n"
printf '%s\n' "$out" >&3
