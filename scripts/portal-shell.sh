#!/usr/bin/env bash
# Gate root script: portal-shell.sh <user> <id> [agent [resume-uuid]]
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=portal-shell

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
MODULE_RE='^[a-z][a-z0-9-]{1,31}$'
ID_RE='^[a-f0-9]{24}$'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
GID_RE='^[0-9]+$'
PROJECTS_ROOT=/srv/projects
RULES_USERS=/opt/claude-rules/users
KEYS_DIR=/etc/gate/keys
PORTAL_GROUP=gate-portal
SERVICE_USER_FILE=/etc/gate/service-user
BOARD_DIR=/var/lib/gate-board

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

in_group() {
  local g
  for g in $(id -nG "$1"); do
    if [[ "$g" == "$2" ]]; then return 0; fi
  done
  return 1
}

has_read_acl() {
  local d="$1" u="$2" line
  while IFS= read -r line; do
    if [[ "$line" == "user:$u:r-x" || "$line" == "user:$u:r-x"[[:space:]]* ]]; then return 0; fi
  done < <(getfacl --absolute-names --omit-header --physical -- "$d" 2>/dev/null || true)
  return 1
}

[[ $# -ge 2 && $# -le 4 ]] || die "kullanım: portal-shell.sh <user> <id> [agent [resume-uuid]]"
u="$1"
sid="$2"
agent_mode=0
resume=""
if [[ $# -ge 3 ]]; then
  [[ "$3" == "agent" ]] || die "geçersiz kip"
  agent_mode=1
fi
if [[ $# -eq 4 ]]; then
  [[ "$4" =~ $UUID_RE ]] || die "geçersiz devam kimliği"
  resume="$4"
fi
check_user "$u"
[[ "$sid" =~ $ID_RE ]] || die "geçersiz oturum kimliği"
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"
getent group "$PORTAL_GROUP" >/dev/null || die "grup yok: $PORTAL_GROUP"
in_group "$u" "$PORTAL_GROUP" || die "kullanıcı $PORTAL_GROUP grubunda değil: $u"

gid="$(id -g "$u")"
[[ "$gid" =~ $GID_RE ]] || die "geçersiz birincil grup"
home="/home/$u"
[[ "$(getent passwd "$u" | cut -d: -f6)" == "$home" ]] || die "beklenmeyen home dizini"
if [[ -L /home || -L "$home" ]]; then die "symlink reddedildi: $home"; fi
[[ -d "$home" ]] || die "home dizini yok: $home"

rules_dir="$RULES_USERS/$u"
if [[ -L /opt/claude-rules || -L "$RULES_USERS" || -L "$rules_dir" ]]; then die "symlink reddedildi: $rules_dir"; fi

rw=()
ro=()
if [[ -L "$PROJECTS_ROOT" ]]; then die "symlink reddedildi: $PROJECTS_ROOT"; fi
if [[ -d "$PROJECTS_ROOT" ]]; then
  for d in "$PROJECTS_ROOT"/*; do
    if [[ -L "$d" || ! -d "$d" ]]; then continue; fi
    name="${d##*/}"
    if [[ ! "$name" =~ $MODULE_RE ]]; then continue; fi
    if getent group "mod-$name" >/dev/null && in_group "$u" "mod-$name"; then
      rw+=("$PROJECTS_ROOT/$name")
    elif has_read_acl "$d" "$u"; then
      ro+=("$PROJECTS_ROOT/$name")
    fi
  done
fi

if [[ -L /etc/gate || -L "$SERVICE_USER_FILE" ]]; then die "symlink reddedildi: $SERVICE_USER_FILE"; fi
[[ -f "$SERVICE_USER_FILE" && "$(stat -c %u -- "$SERVICE_USER_FILE")" == "0" ]] || die "servis kullanıcısı dosyası geçersiz: $SERVICE_USER_FILE"
svc=""
IFS= read -r svc < "$SERVICE_USER_FILE" || true
[[ "$svc" =~ $USER_RE ]] || die "geçersiz servis kullanıcısı"
id -u "$svc" >/dev/null 2>&1 || die "servis kullanıcısı yok: $svc"
svc_gid="$(id -g "$svc")"
[[ "$svc_gid" =~ $GID_RE ]] || die "geçersiz servis kullanıcısı grubu"

for p in /var/lib "$BOARD_DIR" "$BOARD_DIR/public" "$BOARD_DIR/users" "$BOARD_DIR/inbox"; do
  if [[ -L "$p" ]]; then die "symlink reddedildi: $p"; fi
  [[ -d "$p" ]] || die "dizin yok: $p"
done
inbox="$BOARD_DIR/inbox/$u"
if [[ -L "$inbox" ]]; then die "symlink reddedildi: $inbox"; fi
if [[ ! -e "$inbox" ]]; then
  mkdir -- "$inbox"
  chown -h -- "$u:$svc_gid" "$inbox"
  chmod 2770 -- "$inbox"
fi
if [[ -L "$inbox" || ! -d "$inbox" ]]; then die "geçersiz dizin: $inbox"; fi
board_user="$BOARD_DIR/users/$u"
if [[ -L "$board_user" ]]; then die "symlink reddedildi: $board_user"; fi
if [[ ! -e "$board_user" ]]; then
  mkdir -- "$board_user"
  chown -h -- "$svc:$svc_gid" "$board_user"
  chmod 755 -- "$board_user"
fi
if [[ -L "$board_user" || ! -d "$board_user" ]]; then die "geçersiz dizin: $board_user"; fi
# /pano dizin olarak bağlanır (dosya bind'i atomik rename sonrası eski içeriği gösterir);
# alt bağlantı noktaları public içinde boş dizin olarak bulunmalı.
for mp in "$BOARD_DIR/public/ben" "$BOARD_DIR/public/gonder"; do
  if [[ -L "$mp" ]]; then die "symlink reddedildi: $mp"; fi
  if [[ ! -e "$mp" ]]; then install -d -o root -g root -m 755 -- "$mp"; fi
  [[ -d "$mp" ]] || die "geçersiz dizin: $mp"
done

# Yönetici tuş ayarları ~/.claude/keybindings.json üzerine salt okunur bağlanır; bağlantı noktası hazırlanır.
cdir="$home/.claude"
if [[ -L "$cdir" ]]; then die "symlink reddedildi: $cdir"; fi
if [[ ! -e "$cdir" ]]; then install -d -o "$u" -g "$gid" -m 700 -- "$cdir"; fi
[[ -d "$cdir" ]] || die "geçersiz dizin: $cdir"
kb="$cdir/keybindings.json"
if [[ -L "$kb" ]]; then rm -f -- "$kb"; fi
if [[ ! -e "$kb" ]]; then install -o root -g root -m 644 /dev/null "$kb"; fi

unit="gate-portal-$u-$sid"
uid="$(id -u "$u")"
LO_GUARD=/etc/gate/lo-guard.nft
if [[ -L "$LO_GUARD" || ! -f "$LO_GUARD" || "$(stat -c %u -- "$LO_GUARD")" != "0" ]]; then die "geçersiz dosya: $LO_GUARD"; fi
nft list table inet gate_lo >/dev/null 2>&1 || nft -f "$LO_GUARD" || die "lo-guard yüklenemedi"
p_web=$((5100 + uid - 1000))
p_aux=$((5200 + uid - 1000))
nft add element inet gate_lo users "{ $uid }" || die "lo-guard kullanıcı eklenemedi"
nft add element inet gate_lo allow "{ $uid . $p_web, $uid . $p_aux }" || die "lo-guard port eklenemedi"

props=(
  -p "WorkingDirectory=$home"
  -p ProtectSystem=strict
  -p ProtectHome=tmpfs
  -p "BindPaths=$home"
  -p TemporaryFileSystem=/srv:ro
)
for p in "${rw[@]}"; do
  props+=(-p "BindPaths=$p")
done
for p in "${ro[@]}"; do
  props+=(-p "BindReadOnlyPaths=$p")
done
props+=(
  -p "TemporaryFileSystem=$RULES_USERS:ro"
  -p "BindReadOnlyPaths=-$rules_dir"
  -p BindReadOnlyPaths=/usr/local/share/gate/portal-claude:/etc/claude-code
  -p "BindReadOnlyPaths=/usr/local/share/gate/portal-claude/keybindings.json:$home/.claude/keybindings.json"
  -p "BindReadOnlyPaths=$BOARD_DIR/public:/pano"
  -p "BindReadOnlyPaths=-$board_user:/pano/ben"
  -p "BindPaths=$inbox:/pano/gonder"
  -p InaccessiblePaths=/etc/gate
  -p InaccessiblePaths=/etc/sudoers.d
  -p "InaccessiblePaths=-$BOARD_DIR"
  -p InaccessiblePaths=-/var/lib/gate
  -p InaccessiblePaths=-/usr/local/lib/gate
  -p InaccessiblePaths=-/usr/local/share/gate
  -p PrivateTmp=yes
  -p PrivateDevices=yes
  -p NoNewPrivileges=yes
  -p ProtectKernelTunables=yes
  -p ProtectKernelModules=yes
  -p ProtectControlGroups=yes
  -p RestrictSUIDSGID=yes
  -p LockPersonality=yes
  -p ProtectProc=invisible
  -p IPAddressDeny=any
  -p IPAddressAllow=localhost
  -p IPAddressAllow=160.79.104.0/23
  -p IPAddressAllow=2607:6bc0::/48
)
keyfile="$KEYS_DIR/$u.key"
if [[ -L /etc/gate || -L "$KEYS_DIR" || -L "$keyfile" ]]; then die "symlink reddedildi: $keyfile"; fi
if [[ -f "$keyfile" ]]; then
  props+=(-p "LoadCredential=anthropic:$keyfile")
fi
props+=(
  -p Environment=TERM=xterm-256color
  -p "Environment=HOME=$home"
  -p "Environment=USER=$u"
  -p Environment=CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  -p UMask=0007
)

# Sabit metin (kullanıcı girdisi içermez): API anahtarını credential dosyasından ortama aktarır.
# shellcheck disable=SC2016
credentials='if [ -r "${CREDENTIALS_DIRECTORY:-}/anthropic" ]; then k="$(cat "$CREDENTIALS_DIRECTORY/anthropic")"; case "$k" in sk-ant-oat*) CLAUDE_CODE_OAUTH_TOKEN="$k"; export CLAUDE_CODE_OAUTH_TOKEN ;; *) ANTHROPIC_API_KEY="$k"; export ANTHROPIC_API_KEY ;; esac; unset k; fi; '

if [[ "$agent_mode" == "1" ]]; then
  claude_args=(-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode default)
  if [[ ${#rw[@]} -gt 0 || ${#ro[@]} -gt 0 ]]; then
    claude_args+=(--add-dir "${rw[@]}" "${ro[@]}")
  fi
  if [[ -n "$resume" ]]; then
    claude_args+=(--resume "$resume")
  fi
  log "start user=$u unit=$unit rw=${#rw[@]} r=${#ro[@]} mode=agent"
  # Argümanlar kabuk metnine gömülmez; konumsal geçer. Prompt stdin'den gelir.
  # shellcheck disable=SC2016
  launch="$credentials"'exec /bin/bash -l -c '\''exec /usr/local/bin/claude "$@"'\'' claude "$@"'
  exec systemd-run --quiet --pipe --wait --collect "--unit=$unit" "--uid=$u" "--gid=$gid" "${props[@]}" -- /bin/bash -c "$launch" gate-agent "${claude_args[@]}"
fi

log "start user=$u unit=$unit rw=${#rw[@]} r=${#ro[@]}"
launch="$credentials"'exec /bin/bash -l'
exec systemd-run --quiet --pty --wait --collect "--unit=$unit" "--uid=$u" "--gid=$gid" "${props[@]}" -- /bin/bash -c "$launch"
