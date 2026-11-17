#!/usr/bin/env bash
# Gate root script: apikey-set.sh <user> [--delete]   (stdin: anahtar)
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=apikey-set
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
KEY_RE='^sk-ant-[A-Za-z0-9_-]{20,200}$'
GATE_ETC=/etc/gate
KEYS_DIR=/etc/gate/keys

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

[[ $# -eq 1 || $# -eq 2 ]] || die "kullanım: apikey-set.sh <user> [--delete] (stdin: anahtar)"
u="$1"
del=0
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--delete" ]] || die "geçersiz seçenek (--delete)"
  del=1
fi
check_user "$u"

if [[ -L "$GATE_ETC" || -L "$KEYS_DIR" ]]; then die "symlink reddedildi: $KEYS_DIR"; fi
[[ -d "$GATE_ETC" ]] || die "dizin yok: $GATE_ETC"
keyfile="$KEYS_DIR/$u.key"

if [[ "$del" == "1" ]]; then
  if [[ -L "$keyfile" ]]; then die "symlink reddedildi: $keyfile"; fi
  if [[ -e "$keyfile" && ! -f "$keyfile" ]]; then die "normal dosya değil: $keyfile"; fi
  rm -f -- "$keyfile"
  ok "user=$u action=delete"
  exit 0
fi

id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"

key=""
IFS= read -r key || [[ -n "$key" ]] || die "anahtar okunamadı"
extra=""
if IFS= read -r extra || [[ -n "$extra" ]]; then die "stdin tek satır olmalı"; fi
[[ "$key" =~ $KEY_RE ]] || die "geçersiz anahtar biçimi"

install -d -o root -g root -m 700 -- "$KEYS_DIR"
if [[ -L "$keyfile" ]]; then die "symlink reddedildi: $keyfile"; fi
if [[ -e "$keyfile" && ! -f "$keyfile" ]]; then die "normal dosya değil: $keyfile"; fi

tmp="$(mktemp -p "$KEYS_DIR" .key-XXXXXX)"
TMPS+=("$tmp")
printf '%s' "$key" > "$tmp"
chown root:root -- "$tmp"
chmod 600 -- "$tmp"
mv -f -T -- "$tmp" "$keyfile"

ok "user=$u action=set"
