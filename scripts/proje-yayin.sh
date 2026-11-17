#!/usr/bin/env bash
# Gate root script: proje-yayin.sh <project> — ortak test kopyasını GitHub main'ine göre günceller.
set -euo pipefail
umask 027
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C
SCRIPT=proje-yayin
log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; printf '%s\n' "$*"; }
die() { log "hata: $*"; durum hata "$*"; exit 1; }
MODULE_RE='^[a-z][a-z0-9-]{1,31}$'
GIT_ROOT=/srv/gate/git
SERVICE_USER_FILE=/etc/gate/service-user
KEEP=3

[[ $# -eq 1 && "$1" =~ $MODULE_RE ]] || { echo "kullanım: proje-yayin.sh <proje>" >&2; exit 2; }
p="$1"
conf="/etc/gate/yayin/$p.conf"
[[ -f "$conf" && ! -L "$conf" && "$(stat -c %u -- "$conf")" == "0" ]] || { echo "yayın ayarı yok: $conf" >&2; exit 2; }
APP_USER="" SERVICE="" ENV_FILE="" HEALTH_URL="" ROOT_DIR=""
# shellcheck disable=SC1090
. "$conf"
for v in APP_USER SERVICE ENV_FILE HEALTH_URL ROOT_DIR; do [[ -n "${!v}" ]] || { echo "eksik ayar: $v" >&2; exit 2; }; done
svc=""
IFS= read -r svc < "$SERVICE_USER_FILE" || true
bare="$GIT_ROOT/$p.git"
rel_dir="$ROOT_DIR/releases"
cur_link="$ROOT_DIR/current"
state="$ROOT_DIR/durum.json"
lock="$ROOT_DIR/.kilit"

durum() {
  local s="$1" m="$2" t
  t="$(mktemp -p "$ROOT_DIR" .durum.XXXXXX)"
  python3 -I -c 'import json,sys,time; print(json.dumps({"durum":sys.argv[1],"mesaj":sys.argv[2],"surum":sys.argv[3],"zaman":time.strftime("%Y-%m-%dT%H:%M:%S%z")}, ensure_ascii=False))' "$s" "$m" "${3:-}" > "$t"
  chmod 640 "$t"
  chgrp "$APP_USER" "$t"
  mv -f -T "$t" "$state"
}

install -d -o root -g "$APP_USER" -m 750 "$ROOT_DIR" "$rel_dir"
exec 9> "$lock"
flock -n 9 || { echo "başka bir yayın sürüyor"; exit 0; }

runuser -u "$svc" -- git -C "$bare" fetch -q origin
new="$(runuser -u "$svc" -- git -C "$bare" rev-parse --verify -q refs/heads/main)"
cur=""
if [[ -L "$cur_link" ]]; then cur="$(basename "$(readlink -f "$cur_link")")"; fi

for b in $(runuser -u "$svc" -- git -C "$bare" for-each-ref --format='%(refname:short)' 'refs/heads/takim/'); do
  mark="$GIT_ROOT/$p.birlesti"
  if runuser -u "$svc" -- git -C "$bare" merge-base --is-ancestor "$b" main && ! grep -qxF "$b" "$mark" 2>/dev/null; then
    printf '%s\n' "$b" >> "$mark"
    log "birlesti $p $b"
  fi
done

if [[ "$cur" == "$new" ]]; then exit 0; fi
log "guncelleme $p ${cur:-yok} -> $new"

dst="$rel_dir/$new"
work="$rel_dir/.hazirlik-$new"
[[ ! -e "$work" ]] || rm -rf -- "$work"
install -d -o root -g "$APP_USER" -m 750 "$work"
runuser -u "$svc" -- git -C "$bare" archive --format=tar "$new" | tar -x -C "$work"
printf '%s\n' "$new" > "$work/SURUM"
if ! ( cd "$work/backend" && npm ci --no-audit --no-fund --loglevel=error && npm run -s derle ) >"$ROOT_DIR/son-derleme.log" 2>&1; then
  rm -rf -- "$work"; die "arka uç derlenemedi ($new), eski sürüm çalışıyor"
fi
if ! ( cd "$work/frontend" && npm ci --no-audit --no-fund --loglevel=error && npm run -s build ) >>"$ROOT_DIR/son-derleme.log" 2>&1; then
  rm -rf -- "$work"; die "ön yüz derlenemedi ($new), eski sürüm çalışıyor"
fi
chown -R root:"$APP_USER" "$work"
chmod -R g+rX,o-rwx "$work"

mig_changed=1
if [[ -n "$cur" ]] && runuser -u "$svc" -- git -C "$bare" cat-file -e "$cur^{commit}" 2>/dev/null; then
  if [[ -z "$(runuser -u "$svc" -- git -C "$bare" diff --name-only "$cur" "$new" -- backend/migrations)" ]]; then mig_changed=0; fi
fi
if [[ "$mig_changed" == "1" ]]; then
  if ! runuser -u "$APP_USER" -- bash -c 'cd "$1/backend" && set -a && . "$2" && set +a && npm run -s migrate up' gate-yayin "$work" "$ENV_FILE" >>"$ROOT_DIR/son-derleme.log" 2>&1; then
    rm -rf -- "$work"; die "göç başarısız ($new), eski sürüm çalışıyor"
  fi
  log "goc tamam $p $new"
fi

[[ ! -e "$dst" ]] || rm -rf -- "$dst"
mv -T -- "$work" "$dst"
prev="$(readlink -f "$cur_link" 2>/dev/null || true)"
ln -sfn -- "$dst" "$cur_link.yeni"
mv -T -- "$cur_link.yeni" "$cur_link"
systemctl restart "$SERVICE"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ "$ok" != "1" ]]; then
  if [[ -n "$prev" && -d "$prev" ]]; then
    ln -sfn -- "$prev" "$cur_link.yeni"
    mv -T -- "$cur_link.yeni" "$cur_link"
    systemctl restart "$SERVICE"
  fi
  die "yeni sürüm sağlık kontrolünden geçmedi ($new), önceki sürüme dönüldü"
fi

ls -1dt "$rel_dir"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
  old="${old%/}"
  if [[ "$old" != "$(readlink -f "$cur_link")" ]]; then rm -rf -- "$old"; fi
done
durum tamam "yayında" "$new"
log "tamam $p $new"
