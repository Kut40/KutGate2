#!/usr/bin/env bash
# Gate root script: user-del.sh <user>
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=user-del
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
UID_RE='^[0-9]+$'
DELETED_DIR=/var/lib/gate/deleted
SSHD_DIR=/etc/ssh/sshd_config.d
EGRESS_DIR=/etc/gate/egress
EGRESS_ALL=/etc/gate/egress.nft
GATE_ETC=/etc/gate
KEYS_DIR=/etc/gate/keys
RULES_ROOT=/opt/claude-rules
BOARD_DIR=/var/lib/gate-board

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

# Toplu nft dosyasını üretir: $1 çıktı, $2 atlanacak kullanıcı, $3 (ops.) eklenecek kural dosyası
build_aggregate() {
  local out="$1" skip="$2" extra="${3:-}" f base
  {
    printf 'table inet gate\n'
    printf 'delete table inet gate\n'
    printf 'table inet gate {\n'
    printf '\tchain output {\n'
    printf '\t\ttype filter hook output priority 0; policy accept;\n'
    if [[ -d "$EGRESS_DIR" ]]; then
      for f in "$EGRESS_DIR"/*.nft; do
        if [[ ! -f "$f" || -L "$f" ]]; then continue; fi
        base="${f##*/}"
        base="${base%.nft}"
        if [[ "$base" == "$skip" ]]; then continue; fi
        cat -- "$f"
      done
    fi
    if [[ -n "$extra" ]]; then cat -- "$extra"; fi
    printf '\t}\n'
    printf '}\n'
  } > "$out"
}

archive_path() {
  local src="$1" dst="$2"
  if [[ -L "$src" ]]; then
    rm -f -- "$src"
  elif [[ -e "$src" ]]; then
    [[ ! -e "$dst" && ! -L "$dst" ]] || die "hedef zaten var: $dst"
    mkdir -p -- "$DELETED_DIR"
    mv -T -- "$src" "$dst"
  fi
}

[[ $# -eq 1 ]] || die "kullanım: user-del.sh <user>"
u="$1"
check_user "$u"
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"

home="$(getent passwd "$u" | cut -d: -f6)"
[[ "$home" == "/home/$u" ]] || die "beklenmeyen home dizini: $home"

uid="$(id -u "$u")"
if [[ ! "$uid" =~ $UID_RE ]] || (( uid < 1000 )); then die "geçersiz uid: $uid"; fi

for p in "$GATE_ETC" "$KEYS_DIR" "$RULES_ROOT" "$RULES_ROOT/users" "$BOARD_DIR" "$BOARD_DIR/inbox" "$BOARD_DIR/users" /var/lib/gate "$DELETED_DIR"; do
  if [[ -L "$p" ]]; then die "symlink reddedildi: $p"; fi
done
keyfile="$KEYS_DIR/$u.key"
if [[ -e "$keyfile" && ! -L "$keyfile" && ! -f "$keyfile" ]]; then die "normal dosya değil: $keyfile"; fi

# Oturumları sonlandır
loginctl terminate-user "$u" 2>/dev/null || true
pkill -KILL -u "$u" || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! pgrep -u "$u" >/dev/null 2>&1; then break; fi
  pkill -KILL -u "$u" || true
  sleep 0.5
done

# Kullanıcıyı sil (home silinmez)
userdel -- "$u"

stamp="$(date +%Y%m%d%H%M%S)"

# Home'u arşive taşı
if [[ -d "$home" && ! -L "$home" ]]; then
  mkdir -p -- "$DELETED_DIR"
  dest="$DELETED_DIR/${u}-${stamp}"
  [[ ! -e "$dest" ]] || die "hedef zaten var: $dest"
  mv -T -- "$home" "$dest"
fi

if [[ -e "$keyfile" || -L "$keyfile" ]]; then rm -f -- "$keyfile"; fi

archive_path "$RULES_ROOT/users/$u" "$DELETED_DIR/${u}-${stamp}-rules"
archive_path "$BOARD_DIR/inbox/$u" "$DELETED_DIR/${u}-${stamp}-inbox"
archive_path "$BOARD_DIR/users/$u" "$DELETED_DIR/${u}-${stamp}-board"

if nft list table inet gate_lo >/dev/null 2>&1; then
  p_web=$((5100 + uid - 1000))
  p_aux=$((5200 + uid - 1000))
  nft delete element inet gate_lo users "{ $uid }" 2>/dev/null || true
  nft delete element inet gate_lo allow "{ $uid . $p_web }" 2>/dev/null || true
  nft delete element inet gate_lo allow "{ $uid . $p_aux }" 2>/dev/null || true
fi

# sshd kuralını kaldır
conf="$SSHD_DIR/gate-$u.conf"
if [[ -e "$conf" || -L "$conf" ]]; then
  rm -f -- "$conf"
  sshd -t || die "sshd -t başarısız"
  systemctl reload ssh || die "ssh yeniden yüklenemedi"
fi

# egress kuralını kaldır
ufile="$EGRESS_DIR/$u.nft"
if [[ -e "$ufile" || -L "$ufile" ]]; then
  agg_tmp="$(mktemp -p /etc/gate .egress-XXXXXX)"
  TMPS+=("$agg_tmp")
  build_aggregate "$agg_tmp" "$u"
  nft -c -f "$agg_tmp" || die "nft doğrulaması başarısız"
  rm -f -- "$ufile"
  chmod 600 -- "$agg_tmp"
  mv -f -T -- "$agg_tmp" "$EGRESS_ALL"
  nft -f "$EGRESS_ALL" || die "nft yüklenemedi"
fi

ok "user=$u"
