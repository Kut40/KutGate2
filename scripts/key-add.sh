#!/usr/bin/env bash
# Gate root script: key-add.sh <user>   (stdin: anahtar satırı)
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=key-add
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) [A-Za-z0-9+/=]+( [^[:cntrl:]]*)?$'

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

[[ $# -eq 1 ]] || die "kullanım: key-add.sh <user> (stdin: anahtar)"
u="$1"
check_user "$u"
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"

# stdin: tek satır anahtar (sondaki satır sonu kırpılır)
key="$(cat)"
key="${key%$'\n'}"
key="${key%$'\r'}"
[[ -n "$key" ]] || die "anahtar boş"
if [[ "$key" == *$'\n'* || "$key" == *$'\r'* ]]; then die "anahtar tek satır olmalı"; fi
[[ "$key" =~ $KEY_RE ]] || die "geçersiz anahtar biçimi"

home="$(getent passwd "$u" | cut -d: -f6)"
grp="$(id -gn "$u")"
[[ -n "$home" && -d "$home" && ! -L "$home" ]] || die "home dizini bulunamadı"
sshdir="$home/.ssh"
ak="$sshdir/authorized_keys"
if [[ -L "$sshdir" ]]; then die "symlink reddedildi: $sshdir"; fi
if [[ -L "$ak" ]]; then die "symlink reddedildi: $ak"; fi

# ssh-keygen -l -f ile doğrula
ktmp="$(mktemp)"
TMPS+=("$ktmp")
printf '%s\n' "$key" > "$ktmp"
ssh-keygen -l -f "$ktmp" >/dev/null || die "ssh-keygen anahtarı doğrulamadı"

if [[ ! -d "$sshdir" ]]; then
  install -d -m 700 -o "$u" -g "$grp" -- "$sshdir"
fi
if [[ -e "$ak" && ! -f "$ak" ]]; then die "authorized_keys normal dosya değil"; fi

# Zaten varsa ekleme
if [[ -f "$ak" ]] && grep -qxF -- "$key" "$ak"; then
  ok "user=$u mevcut"
  exit 0
fi

new="$(mktemp -p "$sshdir" .gate-ak-XXXXXX)"
TMPS+=("$new")
if [[ -f "$ak" ]]; then
  cat -- "$ak" > "$new"
  if [[ -s "$new" && -n "$(tail -c 1 -- "$new")" ]]; then
    printf '\n' >> "$new"
  fi
fi
printf '%s\n' "$key" >> "$new"
chown "$u:$grp" -- "$new"
chmod 600 -- "$new"
mv -f -T -- "$new" "$ak"

ok "user=$u"
