#!/usr/bin/env bash
# Gate root script: agent-logs.sh <user> list|read <name>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=agent-logs
# Komutların stdout'u stderr'e gider; çıktı yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
NAME_RE='^[A-Za-z0-9._-]{1,200}\.jsonl$'
SUBNAME_RE='^[A-Za-z0-9._-]{1,200}/[A-Za-z0-9._-]{1,200}\.jsonl$'
MAX_BYTES=5242880
MAX_FILES=200

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

valid_name() {
  local n="$1" part
  local -a parts=()
  if [[ ! "$n" =~ $NAME_RE && ! "$n" =~ $SUBNAME_RE ]]; then return 1; fi
  IFS='/' read -r -a parts <<< "$n"
  for part in "${parts[@]}"; do
    if [[ "$part" == "." || "$part" == ".." ]]; then return 1; fi
  done
  return 0
}

[[ $# -ge 2 ]] || die "kullanım: agent-logs.sh <user> list|read <name>"
u="$1"
action="$2"
check_user "$u"
case "$action" in
  list) [[ $# -eq 2 ]] || die "kullanım: agent-logs.sh <user> list" ;;
  read) [[ $# -eq 3 ]] || die "kullanım: agent-logs.sh <user> read <name>" ;;
  *) die "geçersiz işlem (list|read)" ;;
esac
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"
home="/home/$u"
[[ "$(getent passwd "$u" | cut -d: -f6)" == "$home" ]] || die "beklenmeyen home dizini"
root="$home/.claude/projects"
for p in /home "$home" "$home/.claude" "$root"; do
  if [[ -L "$p" ]]; then die "symlink reddedildi: $p"; fi
done

if [[ "$action" == "list" ]]; then
  out="["
  n=0
  if [[ -d "$root" ]]; then
    while IFS=$'\t' read -r -d '' mt sz rel; do
      if (( n >= MAX_FILES )); then break; fi
      if ! valid_name "$rel"; then continue; fi
      [[ "$sz" =~ ^[0-9]+$ ]] || continue
      mt="${mt%%.*}"
      [[ "$mt" =~ ^[0-9]+$ ]] || continue
      if (( n > 0 )); then out+=","; fi
      out+="{\"file\":\"$rel\",\"size\":$sz,\"mtime\":$mt}"
      n=$((n + 1))
    done < <(find -P "$root" -mindepth 1 -maxdepth 2 -name '*.jsonl' -type f -printf '%T@\t%s\t%P\0' | sort -z -r -n)
  fi
  out+="]"
  log "ok user=$u action=list count=$n"
  printf '%s\n' "$out" >&3
  exit 0
fi

name="$3"
valid_name "$name" || die "geçersiz dosya adı"
path="$root/$name"
[[ -d "$root" ]] || die "dizin yok: $root"
if [[ "$name" == */* ]]; then
  sub="$root/${name%%/*}"
  if [[ -L "$sub" ]]; then die "symlink reddedildi: $sub"; fi
  [[ -d "$sub" ]] || die "dizin yok: $sub"
fi
if [[ -L "$path" ]]; then die "symlink reddedildi: $path"; fi
[[ -f "$path" ]] || die "dosya yok: $name"
size="$(stat -c %s -- "$path")"
(( size <= MAX_BYTES )) || die "dosya 5 MB sınırını aşıyor: $name"

log "ok user=$u action=read name=$name"
runuser -u "$u" -- head -c "$MAX_BYTES" -- "$path" >&3
