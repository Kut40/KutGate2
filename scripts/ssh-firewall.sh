#!/usr/bin/env bash
# Gate root script: sudo bash ssh-firewall.sh apply|keep|rollback|status
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=ssh-firewall

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
msg() { log "$*"; printf '%s\n' "$*"; }

GATE_ETC=/etc/gate
RULES=/etc/gate/ssh-firewall.nft
TABLE_FAMILY=inet
TABLE_NAME=gate_ssh
ROLLBACK_UNIT=gate-ssh-rollback
UNIT_NAME=gate-ssh-firewall.service
UNIT_DIR=/etc/systemd/system
UNIT_FILE=/etc/systemd/system/gate-ssh-firewall.service
NFT=/usr/sbin/nft
# SSH ve portala izin verilen ağlar kuruma özeldir: satır başına bir CIDR (IPv4 ve IPv6 ayrı dosyada).
ALLOW_V4=/etc/gate/ssh-allow-v4
ALLOW_V6=/etc/gate/ssh-allow-v6
CIDR4_RE='^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$'
CIDR6_RE='^[0-9a-fA-F:]+/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$'

# İzin listesini okur; dosya yoksa ya da boşsa kural YAZILMAZ (yoksa 22 herkese kapanır, sunucu kilitlenir).
allow_list() {
  local f="$1" re="$2" line out=""
  [[ -f "$f" && ! -L "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"; line="${line//[[:space:]]/}"
    [[ -z "$line" ]] && continue
    [[ "$line" =~ $re ]] || die "geçersiz CIDR ($f): $line"
    out+="${out:+, }$line"
  done < "$f"
  printf '%s' "$out"
}

TMPS=()
cleanup() { local f; for f in "${TMPS[@]}"; do rm -f -- "$f"; done; }
trap cleanup EXIT

usage() { die "kullanım: sudo bash ssh-firewall.sh apply|keep|rollback|status"; }

table_loaded() { "$NFT" list table "$TABLE_FAMILY" "$TABLE_NAME" >/dev/null 2>&1; }

stop_rollback_timer() {
  systemctl stop "$ROLLBACK_UNIT.timer" "$ROLLBACK_UNIT.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$ROLLBACK_UNIT.timer" "$ROLLBACK_UNIT.service" >/dev/null 2>&1 || true
}

delete_table() {
  if table_loaded; then
    "$NFT" delete table "$TABLE_FAMILY" "$TABLE_NAME" || die "tablo silinemedi: $TABLE_FAMILY $TABLE_NAME"
  fi
}

write_rules() {
  local out="$1" v4 v6
  v4="$(allow_list "$ALLOW_V4" "$CIDR4_RE")" || exit 1
  v6="$(allow_list "$ALLOW_V6" "$CIDR6_RE")" || exit 1
  [[ -n "$v4" || -n "$v6" ]] || die "izin listesi boş: $ALLOW_V4 / $ALLOW_V6 (en az bir ağ yazın)"
  {
    printf 'table inet gate_ssh\n'
    printf 'delete table inet gate_ssh\n'
    printf 'table inet gate_ssh {\n'
    printf '\tchain input {\n'
    printf '\t\ttype filter hook input priority -10; policy accept;\n'
    printf '\t\tct state established,related accept\n'
    printf '\t\tiifname "lo" accept\n'
    [[ -n "$v4" ]] && printf '\t\ttcp dport { 22, 4180 } ip saddr { %s } accept\n' "$v4"
    [[ -n "$v6" ]] && printf '\t\ttcp dport { 22, 4180 } ip6 saddr { %s } accept\n' "$v6"
    printf '\t\ttcp dport { 22, 4180 } drop\n'
    printf '\t}\n'
    printf '}\n'
  } > "$out"
}

write_unit() {
  local out="$1"
  {
    printf '[Unit]\n'
    printf 'Description=Gate SSH firewall (nft table inet gate_ssh)\n'
    printf 'After=network-pre.target\n'
    printf 'Before=network.target\n'
    printf '\n'
    printf '[Service]\n'
    printf 'Type=oneshot\n'
    printf 'RemainAfterExit=yes\n'
    printf 'ExecStart=/usr/sbin/nft -f /etc/gate/ssh-firewall.nft\n'
    printf 'ExecStop=/usr/sbin/nft delete table inet gate_ssh\n'
    printf '\n'
    printf '[Install]\n'
    printf 'WantedBy=multi-user.target\n'
  } > "$out"
}

do_apply() {
  local tmp
  if [[ -L "$GATE_ETC" ]]; then die "symlink reddedildi: $GATE_ETC"; fi
  if [[ ! -d "$GATE_ETC" ]]; then install -d -o root -g root -m 755 -- "$GATE_ETC"; fi
  if [[ -L "$RULES" ]]; then die "symlink reddedildi: $RULES"; fi

  tmp="$(mktemp -p "$GATE_ETC" .ssh-firewall-XXXXXX)"
  TMPS+=("$tmp")
  write_rules "$tmp"
  chown root:root -- "$tmp"
  chmod 644 -- "$tmp"
  "$NFT" -c -f "$tmp" || die "nft doğrulaması başarısız; hiçbir kural yüklenmedi"
  mv -f -T -- "$tmp" "$RULES"

  stop_rollback_timer
  "$NFT" -f "$RULES" || die "nft kuralları yüklenemedi"

  if ! systemd-run --unit="$ROLLBACK_UNIT" --on-active=120s "$NFT" delete table "$TABLE_FAMILY" "$TABLE_NAME"; then
    "$NFT" delete table "$TABLE_FAMILY" "$TABLE_NAME" >/dev/null 2>&1 || true
    die "geri alma zamanlayıcısı kurulamadı; kurallar kaldırıldı"
  fi

  log "ok apply (geçici, 120s)"
  printf '%s\n' "Kurallar GEÇİCİ uygulandı. 120 saniye içinde YENİ bir SSH penceresi açıp bağlanabildiğinizi test edin; çalışıyorsa \`sudo bash ssh-firewall.sh keep\` çalıştırın, aksi halde kurallar kendiliğinden geri alınır."
}

do_keep() {
  local tmp
  stop_rollback_timer
  table_loaded || die "tablo yüklü değil ($TABLE_FAMILY $TABLE_NAME); önce apply çalıştırın"
  [[ -f "$RULES" && ! -L "$RULES" ]] || die "kural dosyası yok veya geçersiz: $RULES"
  [[ -d "$UNIT_DIR" && ! -L "$UNIT_DIR" ]] || die "dizin yok: $UNIT_DIR"
  if [[ -L "$UNIT_FILE" ]]; then die "symlink reddedildi: $UNIT_FILE"; fi

  tmp="$(mktemp -p "$UNIT_DIR" .gate-ssh-firewall-XXXXXX)"
  TMPS+=("$tmp")
  write_unit "$tmp"
  chown root:root -- "$tmp"
  chmod 644 -- "$tmp"
  mv -f -T -- "$tmp" "$UNIT_FILE"

  systemctl daemon-reload || die "systemctl daemon-reload başarısız"
  systemctl enable "$UNIT_NAME" || die "$UNIT_NAME etkinleştirilemedi"
  msg "Kurallar KALICI yapıldı: zamanlayıcı durduruldu, $UNIT_NAME etkinleştirildi."
}

do_rollback() {
  stop_rollback_timer
  delete_table
  if [[ -e "$UNIT_FILE" || -L "$UNIT_FILE" ]]; then
    systemctl disable --now "$UNIT_NAME" || true
    rm -f -- "$UNIT_FILE"
  fi
  systemctl daemon-reload || die "systemctl daemon-reload başarısız"
  msg "Geri alındı: tablo $TABLE_FAMILY $TABLE_NAME kaldırıldı, zamanlayıcı ve servis temizlendi."
}

do_status() {
  if table_loaded; then
    printf 'Tablo (%s %s): yüklü\n' "$TABLE_FAMILY" "$TABLE_NAME"
  else
    printf 'Tablo (%s %s): yüklü değil\n' "$TABLE_FAMILY" "$TABLE_NAME"
  fi
  if systemctl is-active --quiet "$ROLLBACK_UNIT.timer" 2>/dev/null; then
    printf 'Geri alma zamanlayıcısı: bekliyor\n'
  else
    printf 'Geri alma zamanlayıcısı: yok\n'
  fi
  if systemctl is-enabled --quiet "$UNIT_NAME" 2>/dev/null; then
    printf 'Servis (%s): etkin\n' "$UNIT_NAME"
  else
    printf 'Servis (%s): etkin değil\n' "$UNIT_NAME"
  fi
}

[[ $# -eq 1 ]] || usage
[[ "$(id -u)" == "0" ]] || die "root olarak çalıştırılmalı"
[[ -x "$NFT" ]] || die "nft bulunamadı: $NFT"

case "$1" in
  apply)    do_apply ;;
  keep)     do_keep ;;
  rollback) do_rollback ;;
  status)   do_status ;;
  *)        usage ;;
esac
