#!/usr/bin/env bash
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=lo-guard-boot

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
UID_RE='^[0-9]+$'
GATE_ETC=/etc/gate
LO_GUARD=/etc/gate/lo-guard.nft
PROTECTED=/etc/gate/protected-users
PORTAL_GROUP=gate-portal

is_protected() {
  local u="$1" f="$PROTECTED" line uid
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

add_member() {
  local u="$1" uid p_web p_aux
  if [[ ! "$u" =~ $USER_RE ]]; then log "geçersiz kullanıcı adı atlandı: $u"; return 1; fi
  if is_protected "$u"; then return 0; fi
  if ! uid="$(id -u "$u" 2>/dev/null)"; then log "kullanıcı yok: $u"; return 1; fi
  if [[ ! "$uid" =~ $UID_RE ]]; then log "geçersiz uid: $u"; return 1; fi
  if (( uid < 1000 )); then return 0; fi
  p_web=$((5100 + uid - 1000))
  p_aux=$((5200 + uid - 1000))
  if ! nft add element inet gate_lo users "{ $uid }"; then log "lo-guard kullanıcı eklenemedi: $u"; return 1; fi
  if ! nft add element inet gate_lo allow "{ $uid . $p_web, $uid . $p_aux }"; then log "lo-guard port eklenemedi: $u"; return 1; fi
  return 0
}

[[ $# -eq 0 ]] || die "kullanım: lo-guard-boot.sh"
[[ "$(id -u)" == "0" ]] || die "root olarak çalıştırılmalı"
command -v nft >/dev/null 2>&1 || die "nft bulunamadı"

if [[ -L "$GATE_ETC" ]]; then die "symlink reddedildi: $GATE_ETC"; fi
if [[ -L "$LO_GUARD" || ! -f "$LO_GUARD" || "$(stat -c %u -- "$LO_GUARD")" != "0" ]]; then die "geçersiz dosya: $LO_GUARD"; fi
[[ -f "$PROTECTED" && ! -L "$PROTECTED" && "$(stat -c %u -- "$PROTECTED")" == "0" ]] || die "korunan kullanıcı dosyası geçersiz: $PROTECTED"

if ! nft list table inet gate_lo >/dev/null 2>&1; then
  nft -f "$LO_GUARD" || die "lo-guard yüklenemedi"
  log "lo-guard yüklendi"
fi

if ! getent group "$PORTAL_GROUP" >/dev/null; then
  log "ok grup yok: $PORTAL_GROUP"
  exit 0
fi

members="$(getent group "$PORTAL_GROUP" | cut -d: -f4)"
IFS=',' read -r -a list <<< "$members"
added=0
failed=0
for m in "${list[@]}"; do
  if [[ -z "$m" ]]; then continue; fi
  if add_member "$m"; then
    added=$((added + 1))
  else
    failed=$((failed + 1))
  fi
done

log "ok üye=$added hata=$failed"
