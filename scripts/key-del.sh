#!/usr/bin/env bash
# Gate root script: key-del.sh <user>   (stdin: anahtar satırı)
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=key-del
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'

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

[[ $# -eq 1 ]] || die "kullanım: key-del.sh <user> (stdin: anahtar)"
u="$1"
check_user "$u"
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"

# stdin: tek satır anahtar (sondaki satır sonu kırpılır)
key="$(cat)"
key="${key%$'\n'}"
key="${key%$'\r'}"
[[ -n "$key" ]] || die "anahtar boş"
if [[ "$key" == *$'\n'* || "$key" == *$'\r'* ]]; then die "anahtar tek satır olmalı"; fi

home="$(getent passwd "$u" | cut -d: -f6)"
grp="$(id -gn "$u")"
[[ -n "$home" && -d "$home" && ! -L "$home" ]] || die "home dizini bulunamadı"
sshdir="$home/.ssh"
ak="$sshdir/authorized_keys"
if [[ -L "$sshdir" ]]; then die "symlink reddedildi: $sshdir"; fi
if [[ -L "$ak" ]]; then die "symlink reddedildi: $ak"; fi

if [[ ! -f "$ak" ]]; then
  ok "user=$u dosya yok"
  exit 0
fi

# Tam eşleşen satırı kaldır
new="$(mktemp -p "$sshdir" .gate-ak-XXXXXX)"
TMPS+=("$new")
rc=0
grep -vxF -- "$key" "$ak" > "$new" || rc=$?
(( rc <= 1 )) || die "authorized_keys okunamadı"
chown "$u:$grp" -- "$new"
chmod 600 -- "$new"
mv -f -T -- "$new" "$ak"

ok "user=$u"
