#!/usr/bin/env bash
# Gate root script: egress-profile.sh <user> <sftp 0|1> <forwarding 0|1> <egress none|allowlist|open> [csv-ip]
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=egress-profile
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
SSHD_DIR=/etc/ssh/sshd_config.d
GATE_ETC=/etc/gate
EGRESS_DIR=/etc/gate/egress
EGRESS_ALL=/etc/gate/egress.nft
GATE_SHELL=/usr/local/sbin/gate-shell

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

valid_v4() {
  local a="$1" o i
  local oct='(0|[1-9][0-9]{0,2})'
  [[ "$a" =~ ^${oct}\.${oct}\.${oct}\.${oct}(/([0-9]{1,2}))?$ ]] || return 1
  for i in 1 2 3 4; do
    o="${BASH_REMATCH[$i]}"
    (( 10#$o <= 255 )) || return 1
  done
  if [[ -n "${BASH_REMATCH[6]}" ]]; then
    (( 10#${BASH_REMATCH[6]} <= 32 )) || return 1
  fi
  return 0
}

valid_v6() {
  local a="$1"
  [[ "$a" =~ ^([0-9A-Fa-f:.]+)(/([0-9]{1,3}))?$ ]] || return 1
  [[ "${BASH_REMATCH[1]}" == *:* ]] || return 1
  if [[ -n "${BASH_REMATCH[3]}" ]]; then
    (( 10#${BASH_REMATCH[3]} <= 128 )) || return 1
  fi
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

[[ $# -eq 4 || $# -eq 5 ]] || die "kullanım: egress-profile.sh <user> <sftp 0|1> <forwarding 0|1> <none|allowlist|open> [csv-ip]"
u="$1"
sftp="$2"
fwd="$3"
egress="$4"
csv="${5:-}"

check_user "$u"
uid="$(id -u "$u" 2>/dev/null)" || die "kullanıcı yok: $u"
[[ "$sftp" == "0" || "$sftp" == "1" ]] || die "geçersiz sftp (0|1)"
[[ "$fwd" == "0" || "$fwd" == "1" ]] || die "geçersiz forwarding (0|1)"
case "$egress" in
  none|allowlist|open) ;;
  *) die "geçersiz egress (none|allowlist|open)" ;;
esac

# IP/CIDR listesi (yalnızca IPv4/IPv6/CIDR, isim yok)
v4=()
v6=()
if [[ -n "$csv" ]]; then
  IFS=',' read -r -a items <<< "$csv"
  for it in "${items[@]}"; do
    if [[ -z "$it" ]]; then continue; fi
    if valid_v4 "$it"; then
      v4+=("$it")
    elif valid_v6 "$it"; then
      v6+=("$it")
    else
      die "geçersiz IP/CIDR: $it"
    fi
  done
fi

for p in "$GATE_ETC" "$EGRESS_DIR" "$SSHD_DIR"; do
  if [[ -L "$p" ]]; then die "symlink reddedildi: $p"; fi
done
[[ -d "$SSHD_DIR" ]] || die "dizin yok: $SSHD_DIR"
mkdir -p -- "$EGRESS_DIR"

ufile="$EGRESS_DIR/$u.nft"
conf="$SSHD_DIR/gate-$u.conf"
if [[ -L "$ufile" || -L "$conf" || -L "$EGRESS_ALL" ]]; then die "symlink reddedildi"; fi

# (b) hazırlık: kullanıcı nft kuralları + toplu dosya, önce doğrula
rule_tmp="$(mktemp -p "$EGRESS_DIR" .tmp-XXXXXX)"
TMPS+=("$rule_tmp")
{
  printf '\t\t# gate user=%s uid=%s egress=%s\n' "$u" "$uid" "$egress"
  if [[ "$egress" != "open" ]]; then
    printf '\t\tmeta skuid %s oifname "lo" accept\n' "$uid"
    printf '\t\tmeta skuid %s ct state established,related accept\n' "$uid"
    if [[ "$egress" == "allowlist" ]]; then
      if (( ${#v4[@]} > 0 )); then
        printf '\t\tmeta skuid %s ip daddr { %s } accept\n' "$uid" "$(IFS=','; printf '%s' "${v4[*]}")"
      fi
      if (( ${#v6[@]} > 0 )); then
        printf '\t\tmeta skuid %s ip6 daddr { %s } accept\n' "$uid" "$(IFS=','; printf '%s' "${v6[*]}")"
      fi
    fi
    printf '\t\tmeta skuid %s drop\n' "$uid"
  fi
} > "$rule_tmp"

agg_tmp="$(mktemp -p "$GATE_ETC" .egress-XXXXXX)"
TMPS+=("$agg_tmp")
build_aggregate "$agg_tmp" "$u" "$rule_tmp"
nft -c -f "$agg_tmp" || die "nft doğrulaması başarısız"

# (a) sshd yapılandırması
backup=""
if [[ -e "$conf" ]]; then
  backup="$(mktemp -p "$SSHD_DIR" .gate-bak-XXXXXX)"
  TMPS+=("$backup")
  cp -p -- "$conf" "$backup"
fi
new="$(mktemp -p "$SSHD_DIR" .gate-new-XXXXXX)"
TMPS+=("$new")
if [[ "$fwd" == "1" ]]; then tcpfwd=yes; else tcpfwd=no; fi
{
  printf 'Match User %s\n' "$u"
  printf '    AllowTcpForwarding %s\n' "$tcpfwd"
  printf '    AllowAgentForwarding no\n'
  printf '    X11Forwarding no\n'
  printf '    PermitTunnel no\n'
  if [[ "$sftp" == "0" ]]; then
    printf '    ForceCommand %s\n' "$GATE_SHELL"
  fi
} > "$new"
chmod 644 -- "$new"
mv -f -T -- "$new" "$conf"

if ! sshd -t; then
  if [[ -n "$backup" ]]; then
    mv -f -T -- "$backup" "$conf"
  else
    rm -f -- "$conf"
  fi
  die "sshd -t başarısız, yapılandırma geri alındı"
fi
systemctl reload ssh || die "ssh yeniden yüklenemedi"

# (b) yükle
chmod 600 -- "$rule_tmp" "$agg_tmp"
mv -f -T -- "$rule_tmp" "$ufile"
mv -f -T -- "$agg_tmp" "$EGRESS_ALL"
nft -f "$EGRESS_ALL" || die "nft yüklenemedi"

ok "user=$u sftp=$sftp forwarding=$fwd egress=$egress"
