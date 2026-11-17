#!/usr/bin/env bash
# Gate root script: user-add.sh <user>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=user-add
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
GATE_ETC=/etc/gate
KEYS_DIR=/etc/gate/keys

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

[[ $# -eq 1 ]] || die "kullanım: user-add.sh <user>"
u="$1"
check_user "$u"

if id -u "$u" >/dev/null 2>&1; then
  die "kullanıcı zaten var: $u"
fi

if [[ -L "$GATE_ETC" || -L "$KEYS_DIR" ]]; then die "symlink reddedildi: $KEYS_DIR"; fi
keyfile="$KEYS_DIR/$u.key"
if [[ -e "$keyfile" && ! -L "$keyfile" && ! -f "$keyfile" ]]; then die "normal dosya değil: $keyfile"; fi
if [[ -e "$keyfile" || -L "$keyfile" ]]; then rm -f -- "$keyfile"; fi

useradd -m -s /bin/bash -- "$u"

home="$(getent passwd "$u" | cut -d: -f6)"
grp="$(id -gn "$u")"
[[ -n "$home" && -d "$home" && ! -L "$home" ]] || die "home dizini bulunamadı: $u"

for d in "$home/.ssh" "$home/.claude" "$home/.claude/skills"; do
  if [[ -L "$d" ]]; then die "symlink reddedildi: $d"; fi
done

install -d -m 700 -o "$u" -g "$grp" -- "$home/.ssh"
if [[ -L "$home/.ssh/authorized_keys" ]]; then die "symlink reddedildi: authorized_keys"; fi
if [[ ! -e "$home/.ssh/authorized_keys" ]]; then
  install -m 600 -o "$u" -g "$grp" /dev/null "$home/.ssh/authorized_keys"
else
  chown "$u:$grp" -- "$home/.ssh/authorized_keys"
  chmod 600 -- "$home/.ssh/authorized_keys"
fi

install -d -m 700 -o "$u" -g "$grp" -- "$home/.claude"
install -d -m 700 -o "$u" -g "$grp" -- "$home/.claude/skills"

ok "user=$u"
