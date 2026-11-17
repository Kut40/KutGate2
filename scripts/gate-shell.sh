#!/usr/bin/env bash
# Gate: gate-shell.sh (kurulum: /usr/local/sbin/gate-shell)
# sshd ForceCommand olarak çalışır; dosya kopyalama komutlarını reddeder.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

SCRIPT=gate-shell

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }

me="$(id -un)"
shell="$(getent passwd "$me" | cut -d: -f7)"
[[ -n "$shell" ]] || die "kullanıcı shell'i bulunamadı"

cmd="${SSH_ORIGINAL_COMMAND:-}"

if [[ -z "$cmd" ]]; then
  log "user=$me oturum"
  exec -l "$shell"
fi

# İlk kelime (baştaki boşluklar atılır), yol öneki kaldırılır
trimmed="${cmd#"${cmd%%[![:space:]]*}"}"
first="${trimmed%%[[:space:]]*}"
base="${first##*/}"

case "$base" in
  scp*|sftp-server*|internal-sftp*|rsync*)
    log "user=$me reddedildi komut=$base"
    die "bu hesapta dosya kopyalama kapalı"
    ;;
esac

log "user=$me komut=$base"
exec "$shell" -c "$cmd"
