#!/usr/bin/env bash
# Gate root script: file-write.sh <abs-path>   (stdin: içerik)
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=file-write
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
RULES_ROOT=/opt/claude-rules
HOME_RE='^/home/([a-z][a-z0-9_-]{1,31})/\.claude/skills/.+$'

TMPS=()
cleanup() { local f; for f in "${TMPS[@]}"; do rm -f -- "$f"; done; }
trap cleanup EXIT

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

# Yol kontrolü: mutlak, `..` yok, boş/"." bileşen yok, kontrol karakteri yok, yalnızca izinli kökler.
# Sonuç: MODE (rules|home), OWNER (home için kullanıcı)
check_path() {
  local p="$1" part
  local -a parts=()
  [[ "$p" == /* ]] || die "yol mutlak olmalı"
  if [[ "$p" == *..* ]]; then die "yol '..' içeremez"; fi
  if [[ "$p" == *[[:cntrl:]]* ]]; then die "yol kontrol karakteri içeremez"; fi
  if [[ "$p" == */ ]]; then die "yol dosya olmalı"; fi
  IFS='/' read -r -a parts <<< "${p#/}"
  for part in "${parts[@]}"; do
    if [[ -z "$part" || "$part" == "." ]]; then die "geçersiz yol bileşeni"; fi
  done

  MODE=""
  OWNER=""
  if [[ "$p" == "$RULES_ROOT/"?* ]]; then
    MODE=rules
  elif [[ "$p" =~ $HOME_RE ]]; then
    MODE=home
    OWNER="${BASH_REMATCH[1]}"
    check_user "$OWNER"
    id -u "$OWNER" >/dev/null 2>&1 || die "kullanıcı yok: $OWNER"
    [[ "$(getent passwd "$OWNER" | cut -d: -f6)" == "/home/$OWNER" ]] || die "beklenmeyen home dizini"
  else
    die "yol izinli köklerin dışında"
  fi
  return 0
}

# Yolun var olan hiçbir bileşeni symlink olamaz
check_no_symlink() {
  local p="$1" cur="" part
  local -a parts=()
  IFS='/' read -r -a parts <<< "${p#/}"
  for part in "${parts[@]}"; do
    cur="$cur/$part"
    if [[ -L "$cur" ]]; then die "symlink reddedildi: $cur"; fi
  done
  return 0
}

[[ $# -eq 1 ]] || die "kullanım: file-write.sh <abs-path> (stdin: içerik)"
path="$1"
check_path "$path"
check_no_symlink "$path"

dir="${path%/*}"
if [[ -e "$path" && ! -f "$path" ]]; then die "normal dosya değil: $path"; fi

if [[ "$MODE" == "rules" ]]; then
  # Dizinleri oluştur (root:root)
  cur=""
  IFS='/' read -r -a dparts <<< "${dir#/}"
  for part in "${dparts[@]}"; do
    cur="$cur/$part"
    if [[ -L "$cur" ]]; then die "symlink reddedildi: $cur"; fi
    if [[ ! -e "$cur" ]]; then
      mkdir -m 755 -- "$cur"
    elif [[ ! -d "$cur" ]]; then
      die "dizin değil: $cur"
    fi
  done
  tmp="$(mktemp -p "$dir" .gate-write-XXXXXX)"
  TMPS+=("$tmp")
  cat > "$tmp"
  chown root:root -- "$tmp"
  chmod 644 -- "$tmp"
  mv -f -T -- "$tmp" "$path"
else
  # /home altı: işlemler o kullanıcı olarak yapılır, sahiplik kullanıcıda
  runuser -u "$OWNER" -- mkdir -p -- "$dir"
  check_no_symlink "$path"
  tmp="$(runuser -u "$OWNER" -- mktemp -p "$dir" .gate-write-XXXXXX)"
  TMPS+=("$tmp")
  runuser -u "$OWNER" -- tee -- "$tmp" >/dev/null
  runuser -u "$OWNER" -- mv -f -T -- "$tmp" "$path"
fi

ok "path=$path"
