#!/usr/bin/env bash
# Gate kurulum: gate-shell'i kurar, /etc/sudoers.d/gate yazar ve visudo -c ile doğrular.
# Çalıştırma (ayrıntı docs/INSTALL.md):
#   sudo GATE_REAL=1 GATE_SERVICE_USER=<servis_kullanicisi> GATE_LICENSE_SRC=<lisans.key> \
#        GATE_PORTAL_HOSTNAME=<gate.alanadiniz> [GATE_PREVIEW_DOMAIN=<alanadiniz>] [GATE_GITHUB_ORG=<hesap>] \
#        [GATE_TEAM_NAME="<takım adı>"] [GATE_SSH_ALLOW_V4="<cidr> <cidr>"] bash <kök>/scripts/install.sh
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=install
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }
ok()  { log "ok $*"; printf '{"ok":true}\n' >&3; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
GATE_ROOT="${GATE_ROOT:-/srv/gate}"
SCRIPTS_DIR="$GATE_ROOT/scripts"
DOCS_DIR="$GATE_ROOT/docs"
LIB_DIR=/usr/local/lib/gate
SUDOERS=/etc/sudoers.d/gate
GATE_SHELL=/usr/local/sbin/gate-shell
GATE_ETC=/etc/gate
PROTECTED=/etc/gate/protected-users
SCRIPTS=(user-add user-del user-lock key-add key-del module-add module-del grant revoke egress-profile rules-init file-write file-delete portal-shell session-kill portal-mode apikey-set agent-logs dev-changes project-list git-proje)
PORTAL_GROUP=gate-portal
SSHD_DIR=/etc/ssh/sshd_config.d
PORTAL_SSHD_CONF=/etc/ssh/sshd_config.d/gate-00-portal.conf
KEYS_DIR=/etc/gate/keys
CLAUDE_DST=/usr/local/bin/claude
CLAUDE_ETC=/etc/claude-code
CLAUDE_MD=/etc/claude-code/CLAUDE.md
SERVICE_USER_FILE=/etc/gate/service-user
BOARD_DIR=/var/lib/gate-board
SYSTEMD_DIR=/etc/systemd/system
BACKEND_DIR="$GATE_ROOT/backend"
DATA_REAL="$GATE_ROOT/data-real"
GATE_ENV=/etc/gate/gate.env
LICENSE_DST=/etc/gate/license.key
HOSTNAME_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
ORG_RE='^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
NODE_PATH_RE='^/[A-Za-z0-9._/+-]+$'

TMPS=()
cleanup() { local f; for f in "${TMPS[@]}"; do rm -f -- "$f"; done; }
trap cleanup EXIT

[[ "${GATE_REAL:-}" == "1" ]] || die "GATE_REAL=1 verilmedi; sistemde değişiklik yapılmadı"
[[ "$(id -u)" == "0" ]] || die "root olarak çalıştırılmalı"
command -v setfacl >/dev/null 2>&1 || die "acl paketi gerekli: apt install acl"

# Güncellemede (install.sh yeniden çalışınca) daha önce verilmiş değerler korunur; yeni verilen değer önceliklidir.
if [[ -f "$GATE_ENV" && ! -L "$GATE_ENV" ]]; then
  while IFS='=' read -r k v || [[ -n "$k" ]]; do
    case "$k" in
      GATE_SERVICE_USER|GATE_PORTAL_HOSTNAME|GATE_PREVIEW_DOMAIN|GATE_GITHUB_ORG|GATE_TEAM_NAME|GATE_SHARED_APPS)
        v="${v#[\"\']}"; v="${v%[\"\']}"
        [[ -z "${!k:-}" ]] && printf -v "$k" '%s' "$v"
        ;;
    esac
  done < "$GATE_ENV"
fi

# Kuruma özel değerler koda yazılmaz; kurulumda verilir ve doğrulanır (değişiklikten ÖNCE).
svc="${GATE_SERVICE_USER:-}"
[[ -n "$svc" ]] || die "GATE_SERVICE_USER verilmedi"
portal_host="${GATE_PORTAL_HOSTNAME:-}"
[[ "$portal_host" =~ $HOSTNAME_RE ]] || die "GATE_PORTAL_HOSTNAME geçersiz ya da verilmedi"
preview_domain="${GATE_PREVIEW_DOMAIN:-}"
[[ -z "$preview_domain" || "$preview_domain" =~ $HOSTNAME_RE ]] || die "GATE_PREVIEW_DOMAIN geçersiz"
github_org="${GATE_GITHUB_ORG:-}"
[[ -z "$github_org" || "$github_org" =~ $ORG_RE ]] || die "GATE_GITHUB_ORG geçersiz"
team_name="${GATE_TEAM_NAME:-Takım}"
TEAM_RE='^[^"$`\\]{1,60}$'
[[ "$team_name" =~ $TEAM_RE ]] || die "GATE_TEAM_NAME geçersiz (1-60 karakter; tırnak, ters bölü ve dolar işareti olmadan)"
shared_apps="${GATE_SHARED_APPS:-}"
[[ "$shared_apps" != *"'"* ]] || die "GATE_SHARED_APPS tek tırnak içeremez"
license_src="${GATE_LICENSE_SRC:-}"
[[ -n "$license_src" && -f "$license_src" && ! -L "$license_src" ]] || [[ -f "$LICENSE_DST" ]] || die "GATE_LICENSE_SRC (lisans dosyası) verilmedi"
[[ "$svc" =~ $USER_RE ]] || die "geçersiz GATE_SERVICE_USER"
id -u "$svc" >/dev/null 2>&1 || die "kullanıcı yok: $svc"
svc_grp="$(id -gn "$svc")"

# Portal: claude ikili dosyası (değişiklikten ÖNCE doğrulanır)
if [[ -n "${GATE_CLAUDE_SRC:-}" ]]; then
  claude_src="$GATE_CLAUDE_SRC"
else
  claude_src="$(readlink -f -- "/home/$svc/.local/bin/claude")" || die "claude kaynağı çözülemedi"
fi
[[ -n "$claude_src" && -f "$claude_src" ]] || die "claude ikili dosyası bulunamadı: $claude_src"
[[ -d /usr/local/bin && ! -L /usr/local/bin ]] || die "/usr/local/bin yok"
if [[ -L "$CLAUDE_DST" ]]; then die "symlink reddedildi: $CLAUDE_DST"; fi

# Kalıcı servisler: node ikili dosyası (değişiklikten ÖNCE doğrulanır)
if [[ -n "${GATE_NODE_BIN:-}" ]]; then
  node_bin="$GATE_NODE_BIN"
else
  node_bin=""
  shopt -s nullglob
  node_cands=("/home/$svc/.nvm/versions/node/"*/bin/node)
  shopt -u nullglob
  if (( ${#node_cands[@]} > 0 )); then
    node_bin="$(printf '%s\n' "${node_cands[@]}" | sort -V | tail -n 1)"
  fi
fi
[[ -n "$node_bin" ]] || die "node bulunamadı (GATE_NODE_BIN verin)"
[[ "$node_bin" =~ $NODE_PATH_RE ]] || die "geçersiz node yolu: $node_bin"
[[ -f "$node_bin" && -x "$node_bin" ]] || die "node çalıştırılabilir dosyası yok: $node_bin"
[[ -d "$SYSTEMD_DIR" && ! -L "$SYSTEMD_DIR" ]] || die "dizin yok: $SYSTEMD_DIR"
for u in gate-admin gate-portal; do
  if [[ -L "$SYSTEMD_DIR/$u.service" ]]; then die "symlink reddedildi: $SYSTEMD_DIR/$u.service"; fi
  if [[ -e "$SYSTEMD_DIR/$u.service" && ! -f "$SYSTEMD_DIR/$u.service" ]]; then die "dosya değil: $SYSTEMD_DIR/$u.service"; fi
done

for s in "${SCRIPTS[@]}" gate-shell lo-guard-boot; do
  f="$SCRIPTS_DIR/$s.sh"
  if [[ -L "$f" ]]; then die "symlink reddedildi: $f"; fi
  [[ -f "$f" ]] || die "script yok: $f"
done

# gate-shell kurulumu
install -o root -g root -m 755 -- "$SCRIPTS_DIR/gate-shell.sh" "$GATE_SHELL"

# Root script'lerini root:root sahipliğinde LIB_DIR altına kopyala
[[ -d /usr/local/lib && ! -L /usr/local/lib ]] || die "/usr/local/lib yok"
if [[ -L "$LIB_DIR" ]]; then die "symlink reddedildi: $LIB_DIR"; fi
rm -rf -- "$LIB_DIR"
install -d -o root -g root -m 755 -- "$LIB_DIR"
for s in "${SCRIPTS[@]}"; do
  f="$SCRIPTS_DIR/$s.sh"
  if [[ -L "$f" ]]; then die "symlink reddedildi: $f"; fi
  [[ -f "$f" ]] || die "script yok: $f"
  install -o root -g root -m 755 -- "$f" "$LIB_DIR/$s.sh"
done
f="$SCRIPTS_DIR/lo-guard-boot.sh"
if [[ -L "$f" ]]; then die "symlink reddedildi: $f"; fi
[[ -f "$f" ]] || die "script yok: $f"
install -o root -g root -m 755 -- "$f" "$LIB_DIR/lo-guard-boot.sh"

# Korunan kullanıcı dosyası (varsa dokunulmaz)
if [[ -L "$GATE_ETC" ]]; then die "symlink reddedildi: $GATE_ETC"; fi
if [[ ! -d "$GATE_ETC" ]]; then install -d -o root -g root -m 755 -- "$GATE_ETC"; fi
if [[ -L "$PROTECTED" ]]; then die "symlink reddedildi: $PROTECTED"; fi
if [[ ! -e "$PROTECTED" ]]; then
  prot_tmp="$(mktemp -p "$GATE_ETC" .protected-XXXXXX)"
  TMPS+=("$prot_tmp")
  printf 'root\n%s\n' "$svc" > "$prot_tmp"
  chown root:root -- "$prot_tmp"
  chmod 644 -- "$prot_tmp"
  mv -T -- "$prot_tmp" "$PROTECTED"
fi

# Claude kural kökü: genel kurallar + yeni kullanıcıya kopyalanan şablon (rules-init bunu ister). Varsa dokunulmaz.
RULES_ROOT=/opt/claude-rules
for p in "$RULES_ROOT" "$RULES_ROOT/global" "$RULES_ROOT/global/rules" "$RULES_ROOT/global/references" \
         "$RULES_ROOT/users" "$RULES_ROOT/users/_template" "$RULES_ROOT/users/_template/rules" \
         "$RULES_ROOT/users/_template/references" "$RULES_ROOT/scripts"; do
  if [[ -L "$p" ]]; then die "symlink reddedildi: $p"; fi
  if [[ -e "$p" && ! -d "$p" ]]; then die "dizin değil: $p"; fi
  [[ -d "$p" ]] || install -d -o root -g root -m 755 -- "$p"
done

# Servis kullanıcısı dosyası (her kurulumda atomik yazılır)
if [[ -L "$SERVICE_USER_FILE" ]]; then die "symlink reddedildi: $SERVICE_USER_FILE"; fi
if [[ -e "$SERVICE_USER_FILE" && ! -f "$SERVICE_USER_FILE" ]]; then die "dosya değil: $SERVICE_USER_FILE"; fi
svcf_tmp="$(mktemp -p "$GATE_ETC" .service-user-XXXXXX)"
TMPS+=("$svcf_tmp")
printf '%s\n' "$svc" > "$svcf_tmp"
chown root:root -- "$svcf_tmp"
chmod 644 -- "$svcf_tmp"
mv -f -T -- "$svcf_tmp" "$SERVICE_USER_FILE"

# Kurulum değerleri: tek kaynak /etc/gate/gate.env (systemd EnvironmentFile). Atomik yazılır.
write_etc() {  # write_etc <hedef> <mod> <grup> ; içerik stdin'den
  local dst="$1" mode="$2" grp="$3" tmp
  if [[ -L "$dst" ]]; then die "symlink reddedildi: $dst"; fi
  tmp="$(mktemp -p "$GATE_ETC" .etc-XXXXXX)"
  TMPS+=("$tmp")
  cat > "$tmp"
  chown "root:$grp" -- "$tmp"
  chmod "$mode" -- "$tmp"
  mv -f -T -- "$tmp" "$dst"
}
printf '%s\n' "$node_bin" | write_etc "$GATE_ETC/node-bin" 644 root
{
  printf 'GATE_SERVICE_USER=%s\n' "$svc"
  printf 'GATE_PORTAL_HOSTNAME=%s\n' "$portal_host"
  [[ -n "$preview_domain" ]] && printf 'GATE_PREVIEW_DOMAIN=%s\n' "$preview_domain"
  [[ -n "$github_org" ]] && printf 'GATE_GITHUB_ORG=%s\n' "$github_org"
  printf 'GATE_TEAM_NAME="%s"\n' "$team_name"
  [[ -n "$shared_apps" ]] && printf "GATE_SHARED_APPS='%s'\n" "$shared_apps"
  printf 'GATE_LICENSE_FILE=%s\n' "$LICENSE_DST"
} | write_etc "$GATE_ENV" 640 "$svc_grp"
if [[ -n "$github_org" ]]; then
  printf '%s\n' "$github_org" | write_etc "$GATE_ETC/github-org" 644 root
else
  rm -f -- "$GATE_ETC/github-org"
fi
if [[ -n "$license_src" ]]; then
  write_etc "$LICENSE_DST" 640 "$svc_grp" < "$license_src"
fi
# SSH izin listesi yalnız ilk kurulumda yazılır; sonra elle düzenlenir (ssh-firewall.sh okur).
if [[ -n "${GATE_SSH_ALLOW_V4:-}" && ! -e "$GATE_ETC/ssh-allow-v4" ]]; then
  printf '%s\n' ${GATE_SSH_ALLOW_V4} | write_etc "$GATE_ETC/ssh-allow-v4" 644 root
fi

# Takım panosu ve geliştirme günlüğü dizinleri
[[ -d /var/lib && ! -L /var/lib ]] || die "/var/lib yok"
for p in "$BOARD_DIR" "$BOARD_DIR/public" "$BOARD_DIR/users" "$BOARD_DIR/inbox"; do
  if [[ -L "$p" ]]; then die "symlink reddedildi: $p"; fi
  if [[ -e "$p" && ! -d "$p" ]]; then die "dizin değil: $p"; fi
done
install -d -o "$svc" -g "$svc_grp" -m 755 -- "$BOARD_DIR"
install -d -o "$svc" -g "$svc_grp" -m 755 -- "$BOARD_DIR/public" "$BOARD_DIR/users"
install -d -o root -g root -m 755 -- "$BOARD_DIR/inbox"
for f in "$BOARD_DIR/public/Geliştirme_notu.md" "$BOARD_DIR/public/pano.md"; do
  if [[ -L "$f" ]]; then die "symlink reddedildi: $f"; fi
  if [[ ! -e "$f" ]]; then
    board_tmp="$(mktemp -p "$BOARD_DIR/public" .board-XXXXXX)"
    TMPS+=("$board_tmp")
    chown -- "$svc:$svc_grp" "$board_tmp"
    chmod 644 -- "$board_tmp"
    mv -T -- "$board_tmp" "$f"
  fi
done

# Portal: gate-portal grubu
if ! getent group "$PORTAL_GROUP" >/dev/null; then
  groupadd -- "$PORTAL_GROUP"
fi

# Portal: SSH girişini gate-portal grubuna kapat
[[ -d "$SSHD_DIR" && ! -L "$SSHD_DIR" ]] || die "dizin yok: $SSHD_DIR"
if [[ -L "$PORTAL_SSHD_CONF" ]]; then die "symlink reddedildi: $PORTAL_SSHD_CONF"; fi
portal_bak=""
if [[ -e "$PORTAL_SSHD_CONF" ]]; then
  portal_bak="$(mktemp -p "$SSHD_DIR" .gate-bak-XXXXXX)"
  TMPS+=("$portal_bak")
  cp -p -- "$PORTAL_SSHD_CONF" "$portal_bak"
fi
portal_new="$(mktemp -p "$SSHD_DIR" .gate-new-XXXXXX)"
TMPS+=("$portal_new")
printf 'DenyGroups %s\n' "$PORTAL_GROUP" > "$portal_new"
chown root:root -- "$portal_new"
chmod 644 -- "$portal_new"
mv -f -T -- "$portal_new" "$PORTAL_SSHD_CONF"
if ! sshd -t; then
  if [[ -n "$portal_bak" ]]; then
    mv -f -T -- "$portal_bak" "$PORTAL_SSHD_CONF"
  else
    rm -f -- "$PORTAL_SSHD_CONF"
  fi
  die "sshd -t başarısız, $PORTAL_SSHD_CONF geri alındı"
fi
systemctl reload ssh || die "ssh yeniden yüklenemedi"

# Portal: API anahtarı dizini
if [[ -L "$KEYS_DIR" ]]; then die "symlink reddedildi: $KEYS_DIR"; fi
if [[ -e "$KEYS_DIR" && ! -d "$KEYS_DIR" ]]; then die "dizin değil: $KEYS_DIR"; fi
install -d -o root -g root -m 700 -- "$KEYS_DIR"

# Portal: claude ikili dosyasını kur
install -o root -g root -m 755 -- "$claude_src" "$CLAUDE_DST"

# Portal: yönetilen Claude kuralları yalnızca Portal sandbox'ında /etc/claude-code yerine bağlanır.
# Kaynak: $DOCS_DIR/portal-claude → $PORTAL_CLAUDE_DIR (root:root, her kurulumda güncellenir).
PORTAL_CLAUDE_SRC="$DOCS_DIR/portal-claude"
PORTAL_CLAUDE_DIR=/usr/local/share/gate/portal-claude
for pf in CLAUDE.md managed-settings.json guard.py giris.py keybindings.json; do
  [[ -f "$PORTAL_CLAUDE_SRC/$pf" && ! -L "$PORTAL_CLAUDE_SRC/$pf" ]] || die "portal dosyası yok: $PORTAL_CLAUDE_SRC/$pf"
done
python3 -I -c 'import json,sys; json.load(open(sys.argv[1])); json.load(open(sys.argv[2]))' "$PORTAL_CLAUDE_SRC/managed-settings.json" "$PORTAL_CLAUDE_SRC/keybindings.json" || die "portal JSON dosyası geçersiz"
python3 -I -m py_compile "$PORTAL_CLAUDE_SRC/guard.py" "$PORTAL_CLAUDE_SRC/giris.py" || die "guard.py/giris.py derlenemedi"
if [[ -L /usr/local/share/gate || -L "$PORTAL_CLAUDE_DIR" ]]; then die "symlink reddedildi: $PORTAL_CLAUDE_DIR"; fi
install -d -o root -g root -m 755 -- /usr/local/share/gate "$PORTAL_CLAUDE_DIR"
for pf in CLAUDE.md managed-settings.json guard.py giris.py keybindings.json; do
  install -o root -g root -m 644 -- "$PORTAL_CLAUDE_SRC/$pf" "$PORTAL_CLAUDE_DIR/$pf"
done
rm -rf -- "$PORTAL_CLAUDE_DIR/__pycache__"

# Eski sürümün sunucu geneline yazdığı /etc/claude-code/CLAUDE.md'yi kaldır (yalnızca içerik birebir eskisiyse).
if [[ -f "$CLAUDE_MD" && ! -L "$CLAUDE_MD" ]]; then
  old_md='Bu sunucuda her oturumun başında önce `/opt/claude-rules/global/` altındaki kuralları, sonra `/opt/claude-rules/users/$USER/` altındaki kuralları oku ve uy. Yalnızca `/srv/projects/` altında sana açılmış klasörlerde çalış. Dosya içeriklerini sunucu dışına aktarmaya yardım etme.'
  if [[ "$(cat -- "$CLAUDE_MD")" == "$old_md" ]]; then
    rm -f -- "$CLAUDE_MD"
    rmdir -- "$CLAUDE_ETC" 2>/dev/null || true
  fi
fi

# sudoers içeriği
content_tmp="$(mktemp)"
TMPS+=("$content_tmp")
for s in "${SCRIPTS[@]}"; do
  printf '%s ALL=(root) NOPASSWD: %s/%s.sh\n' "$svc" "$LIB_DIR" "$s"
done > "$content_tmp"

# /etc/sudoers.d/gate yaz (geçici adı '.' içerdiği için sudo tarafından okunmaz)
[[ -d /etc/sudoers.d && ! -L /etc/sudoers.d ]] || die "/etc/sudoers.d yok"
if [[ -L "$SUDOERS" ]]; then die "symlink reddedildi: $SUDOERS"; fi
sud_tmp="$(mktemp -p /etc/sudoers.d .gate-XXXXXX)"
TMPS+=("$sud_tmp")
cat -- "$content_tmp" > "$sud_tmp"
chown root:root -- "$sud_tmp"
chmod 440 -- "$sud_tmp"
visudo -c -q -f "$sud_tmp" || die "visudo doğrulaması başarısız (geçici dosya)"
mv -f -T -- "$sud_tmp" "$SUDOERS"
if ! visudo -c -q; then
  rm -f -- "$SUDOERS"
  die "visudo -c başarısız; $SUDOERS kaldırıldı"
fi

# docs/sudoers.d-gate.example
if [[ -d "$DOCS_DIR" && ! -L "$DOCS_DIR" ]]; then
  ex="$DOCS_DIR/sudoers.d-gate.example"
  if [[ -L "$ex" ]]; then die "symlink reddedildi: $ex"; fi
  install -o "$svc" -g "$svc_grp" -m 644 -- "$content_tmp" "$ex"
fi

# Kalıcı servisler: gate-admin.service ve gate-portal.service (yazılır, enable edilir, BAŞLATILMAZ)
write_unit() {
  local name="$1" desc="$2" entry="$3" tmp
  tmp="$(mktemp -p "$SYSTEMD_DIR" ".$name-XXXXXX")"
  TMPS+=("$tmp")
  cat > "$tmp" <<EOF
[Unit]
Description=$desc
After=network-online.target

[Service]
User=$svc
WorkingDirectory=$BACKEND_DIR
EnvironmentFile=$GATE_ENV
Environment=GATE_DRY_RUN=0 GATE_DATA_DIR=$DATA_REAL GATE_SCRIPTS_DIR=$LIB_DIR GATE_FRONTEND_DIR=$GATE_ROOT/frontend/dist NODE_ENV=production
ExecStart=$node_bin $BACKEND_DIR/node_modules/tsx/dist/cli.mjs $entry
Restart=on-failure
RestartSec=3
# Lisans geçersizse süreç 78 ile çıkar; yeniden denemek anlamsızdır (lisans yenilenince elle başlatılır).
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
EOF
  chown root:root -- "$tmp"
  chmod 644 -- "$tmp"
  mv -f -T -- "$tmp" "$SYSTEMD_DIR/$name.service"
}
write_unit gate-admin "Gate admin paneli" src/server.ts
write_unit gate-portal "Gate Portal" src/portal.ts

# Açılışta ağ kısıtlarını yeniden yükleyen tek seferlik servisler (kural dosyası yoksa çalışmazlar).
write_oneshot() {  # write_oneshot <ad> <açıklama> <After> <Before> <koşul dosyası> <ExecStart>
  local tmp
  tmp="$(mktemp -p "$SYSTEMD_DIR" ".$1-XXXXXX")"
  TMPS+=("$tmp")
  {
    printf '[Unit]\nDescription=%s\nAfter=%s\n' "$2" "$3"
    [[ -n "$4" ]] && printf 'Before=%s\n' "$4"
    printf 'ConditionPathExists=%s\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=%s\n\n[Install]\nWantedBy=multi-user.target\n' "$5" "$6"
  } > "$tmp"
  chown root:root -- "$tmp"
  chmod 644 -- "$tmp"
  mv -f -T -- "$tmp" "$SYSTEMD_DIR/$1.service"
}
write_oneshot gate-egress "Gate egress kısıtı (nft table inet gate)" network-pre.target network.target /etc/gate/egress.nft "/usr/sbin/nft -f /etc/gate/egress.nft"
write_oneshot gate-lo-guard "Gate lo-guard (nft table inet gate_lo)" "gate-egress.service ufw.service" gate-portal.service /etc/gate/lo-guard.nft "$LIB_DIR/lo-guard-boot.sh"
systemctl daemon-reload || die "systemctl daemon-reload başarısız"
systemctl enable gate-admin.service gate-portal.service gate-egress.service gate-lo-guard.service || die "servisler enable edilemedi"

ok "service_user=$svc"
