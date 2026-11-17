#!/usr/bin/env bash
# Gate root script: git-proje.sh <user> <project> send|clone|env
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C
SCRIPT=git-proje
exec 3>&1 1>&2
log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
fail() { log "ret $u $p: $1"; printf '{"ok":false,"error":"%s","detail":%s}\n' "$1" "$2" >&3; exit 0; }
USER_RE='^[a-z][a-z0-9_-]{1,31}$'
MODULE_RE='^[a-z][a-z0-9-]{1,31}$'
GIT_ROOT=/srv/gate/git
PORTAL_GROUP=gate-portal
SERVICE_USER_FILE=/etc/gate/service-user
# İzin verilen GitHub hesabı kurulumda yazılır; dosya yoksa yeni depo bağlanmaz (fail-closed).
GITHUB_ORG_FILE=/etc/gate/github-org
ORG_RE='^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
MAX_BUNDLE=$((300 * 1024 * 1024))

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
in_group() {
  local g
  for g in $(id -nG "$1"); do
    if [[ "$g" == "$2" ]]; then return 0; fi
  done
  return 1
}
json_str() { python3 -I -c 'import json,sys; print(json.dumps(sys.stdin.read()[:2000]))'; }
origin_izinli() {
  local org
  [[ -f "$GITHUB_ORG_FILE" && ! -L "$GITHUB_ORG_FILE" ]] || return 1
  org="$(head -n1 -- "$GITHUB_ORG_FILE")"
  [[ "$org" =~ $ORG_RE ]] || return 1
  [[ "$1" == "git@github.com:$org/"* ]] || return 1
  [[ "${1#git@github.com:$org/}" =~ ^[A-Za-z0-9_.-]{1,100}\.git$ ]]
}

[[ $# -eq 3 ]] || die "kullanım: git-proje.sh <user> <project> send|sync|clone|env"
u="$1"
p="$2"
mode="$3"
[[ "$u" =~ $USER_RE ]] || die "geçersiz kullanıcı adı"
[[ "$p" =~ $MODULE_RE ]] || die "geçersiz proje adı"
[[ "$mode" == "send" || "$mode" == "sync" || "$mode" == "clone" || "$mode" == "env" ]] || die "geçersiz kip"
if is_protected "$u"; then die "korunan hesap: $u"; fi
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"
in_group "$u" "$PORTAL_GROUP" || die "kullanıcı $PORTAL_GROUP grubunda değil: $u"
gid="$(id -g "$u")"
home="/home/$u"
[[ "$(getent passwd "$u" | cut -d: -f6)" == "$home" ]] || die "beklenmeyen home dizini"
if [[ -L /home || -L "$home" || ! -d "$home" ]]; then die "geçersiz home: $home"; fi
if [[ -L /etc/gate || -L "$SERVICE_USER_FILE" ]]; then die "symlink reddedildi: $SERVICE_USER_FILE"; fi
[[ -f "$SERVICE_USER_FILE" && "$(stat -c %u -- "$SERVICE_USER_FILE")" == "0" ]] || die "servis kullanıcısı dosyası geçersiz"
svc=""
IFS= read -r svc < "$SERVICE_USER_FILE" || true
[[ "$svc" =~ $USER_RE ]] || die "geçersiz servis kullanıcısı"
bare="$GIT_ROOT/$p.git"
bare_dirs=("$GIT_ROOT" "$GIT_ROOT/incoming")
if [[ "$mode" != "send" || -e "$bare" ]]; then bare_dirs+=("$bare"); fi
for d in "${bare_dirs[@]}"; do
  if [[ -L "$d" || ! -d "$d" ]]; then die "geçersiz dizin: $d"; fi
  [[ "$(stat -c %U -- "$d")" == "$svc" ]] || die "beklenmeyen sahip: $d"
done

extra=()
workdir=""
sandbox() {
  systemd-run --quiet --pipe --wait --collect "--uid=$u" "--gid=$gid" "${extra[@]}" \
    -p "WorkingDirectory=$home" \
    -p ProtectSystem=strict -p ProtectHome=tmpfs -p "BindPaths=$home" \
    -p TemporaryFileSystem=/srv:ro -p InaccessiblePaths=/etc/gate -p InaccessiblePaths=-/var/lib/gate-board \
    -p PrivateTmp=yes -p PrivateDevices=yes -p NoNewPrivileges=yes -p RestrictSUIDSGID=yes \
    -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes \
    -p IPAddressDeny=any -p RuntimeMaxSec=170 \
    -p "Environment=HOME=$home" -p "Environment=USER=$u" -p UMask=0007 \
    -- /bin/bash -c "$1" gate-git "$p" "$u" "$workdir"
}

# Sabit metinler; kullanıcı girdisi konumsal argüman ya da stdin olarak geçer.
# shellcheck disable=SC2016
SEND='set -euo pipefail
dir="${3:-$HOME/projeler/$1}"
[[ -d "$dir/.git" && ! -L "$dir" ]] || { echo "proje_yok" >&2; exit 4; }
cd "$dir"
msg="$(head -c 2000)"
git add -A
bad="$(git ls-files | grep -E "(^|/)\.env(\.[^/]*)?$|\.(pem|key|p12|pfx)$|(^|/)node_modules/" | grep -vE "(^|/)\.env\.(ornek|example|gelistirme)$" || true)"
if [[ -n "$bad" ]]; then git reset -q; printf "%s\n" "$bad" | head -20 >&2; exit 3; fi
if ! git diff --cached --quiet; then
  git -c "user.name=$2" -c "user.email=$2@kutgate.local" commit -q -m "$msg"
fi
git bundle create -q - HEAD'
# shellcheck disable=SC2016
SYNC='set -euo pipefail
dir="${3:-$HOME/projeler/$1}"
[[ -d "$dir/.git" && ! -L "$dir" ]] || { echo "proje_yok" >&2; exit 4; }
cd "$dir"
t="$(mktemp -p "$dir/.git" kutgate-main.XXXXXX)"
head -c 314572800 > "$t"
git fetch -q "$t" "+refs/heads/main:refs/remotes/kutgate/main"
rm -f "$t"
if git merge-base --is-ancestor refs/remotes/kutgate/main HEAD; then echo guncel; exit 0; fi
if git -c "user.name=$2" -c "user.email=$2@kutgate.local" merge -q --no-edit -m "Ana kod (main) ile güncellendi" refs/remotes/kutgate/main >/dev/null 2>"$dir/.git/kutgate-merge.err"; then
  rm -f "$dir/.git/kutgate-merge.err"; echo birlesti; exit 0
fi
if [[ -f "$dir/.git/MERGE_HEAD" ]]; then
  git diff --name-only --diff-filter=U | head -30 >&2
  git merge --abort >/dev/null 2>&1 || true
  rm -f "$dir/.git/kutgate-merge.err"; exit 6
fi
grep -E "^[[:space:]]+[^[:space:]]" "$dir/.git/kutgate-merge.err" | sed "s/^[[:space:]]*//" | head -30 >&2 || true
rm -f "$dir/.git/kutgate-merge.err"; exit 7'
# shellcheck disable=SC2016
CLONE='set -euo pipefail
mkdir -p "$HOME/projeler"
dir="$HOME/projeler/$1"
[[ ! -e "$dir" ]] || { echo "proje_var" >&2; exit 5; }
b="$HOME/projeler/.$1.bundle"
rm -f "$b"
head -c 314572800 > "$b"
git clone -q "$b" "$dir"
rm -f "$b"
git -C "$dir" remote remove origin
git -C "$dir" checkout -q -B "takim/$2"
git -C "$dir" config user.name "$2"
git -C "$dir" config user.email "$2@kutgate.local"'
# shellcheck disable=SC2016
ENVW='set -euo pipefail
dir="$HOME/projeler/$1"
[[ -d "$dir" && ! -L "$dir" && ! -L "$dir/.env" ]] || { echo "proje_yok" >&2; exit 4; }
t="$(mktemp "$dir/.env.XXXXXX")"
head -c 20000 > "$t"
chmod 600 "$t"
mv -f -T "$t" "$dir/.env"
grep -E "^[A-Z0-9_]+_DIZINI=" "$dir/.env" | cut -d= -f2- | while IFS= read -r d; do
  case "$d" in "$HOME"/*) [[ "$d" != *..* ]] && mkdir -p -- "$d" ;; esac
done'

case "$mode" in
  send|sync)
    shared="/srv/projects/$p"
    if [[ ! -d "$home/projeler/$p/.git" && -d "$shared/.git" && ! -L "$shared" && ! -L /srv/projects ]] \
      && getent group "mod-$p" >/dev/null && in_group "$u" "mod-$p"; then
      workdir="$shared"
      extra=(-p "BindPaths=$shared")
    fi
    origin=""
    if [[ -n "$workdir" && -f "$shared/.git/config" && ! -L "$shared/.git" && ! -L "$shared/.git/config" ]]; then
      origin="$(git config --file "$shared/.git/config" --get remote.origin.url 2>/dev/null || true)"
    fi
    if [[ "$mode" == "sync" ]]; then
      [[ -e "$bare" ]] || fail bagli_degil null
      errf="$(mktemp)"
      trap 'rm -f -- "$errf"' EXIT
      runuser -u "$svc" -- git -C "$bare" fetch -q origin || true
      set +e
      res="$(runuser -u "$svc" -- git -C "$bare" bundle create -q - refs/heads/main | sandbox "$SYNC" 2> "$errf")"
      rc=$?
      set -e
      case "$rc" in
        0) ;;
        4) fail proje_yok null ;;
        6) fail cakisma "$(json_str < "$errf")" ;;
        7) fail yerel_degisiklik "$(json_str < "$errf")" ;;
        *) fail git_hata "$(json_str < "$errf")" ;;
      esac
      [[ "$res" == "guncel" || "$res" == "birlesti" ]] || res="birlesti"
      log "sync $u $p $res"
      printf '{"ok":true,"sonuc":"%s"}\n' "$res" >&3
      exit 0
    fi
    if [[ ! -e "$bare" ]]; then
      origin_izinli "$origin" || fail origin_yok null
    fi
    tmp="$(mktemp -p "$GIT_ROOT/incoming" ".$u-$p.XXXXXX")"
    errf="$(mktemp)"
    trap 'rm -f -- "$tmp" "$errf"' EXIT
    set +e
    head -c 2000 | sandbox "$SEND" > "$tmp" 2> "$errf"
    rc=$?
    set -e
    case "$rc" in
      0) ;;
      3) fail yasak_dosya "$(json_str < "$errf")" ;;
      4) fail proje_yok null ;;
      *) fail git_hata "$(json_str < "$errf")" ;;
    esac
    size="$(stat -c %s -- "$tmp")"
    (( size > 0 && size <= MAX_BUNDLE )) || fail boyut null
    chown -- "$svc" "$tmp"
    chmod 600 -- "$tmp"
    out="$GIT_ROOT/incoming/$u-$p.bundle"
    mv -f -T -- "$tmp" "$out"
    trap 'rm -f -- "$errf"' EXIT
    log "send $u $p $size"
    origin_izinli "$origin" || origin=""
    printf '{"ok":true,"bundle":"%s","origin":"%s"}\n' "$out" "$origin" >&3
    ;;
  clone)
    errf="$(mktemp)"
    trap 'rm -f -- "$errf"' EXIT
    set +e
    runuser -u "$svc" -- git -C "$bare" bundle create -q - refs/heads/main | sandbox "$CLONE" 2> "$errf"
    rc=$?
    set -e
    case "$rc" in
      0) ;;
      5) fail proje_var null ;;
      *) fail git_hata "$(json_str < "$errf")" ;;
    esac
    cache="$GIT_ROOT/cache/$p"
    if [[ -d "$cache" && ! -L "$cache" ]]; then
      tar -C "$cache" -c . | sandbox 'tar -x -C "$HOME/projeler/$1"'
    fi
    log "clone $u $p"
    printf '{"ok":true}\n' >&3
    ;;
  env)
    errf="$(mktemp)"
    trap 'rm -f -- "$errf"' EXIT
    set +e
    head -c 20000 | sandbox "$ENVW" 2> "$errf"
    rc=$?
    set -e
    [[ "$rc" == "0" ]] || fail env_hata "$(json_str < "$errf")"
    log "env $u $p"
    printf '{"ok":true}\n' >&3
    ;;
esac
