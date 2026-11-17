#!/usr/bin/env bash
# Gate root script: project-list.sh <user> <project> [relpath]
# Yetkili projede tek klasör düzeyinin adlarını listeler. Dosya içeriği okunmaz, sembolik bağ izlenmez.
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
export LC_ALL=C

SCRIPT=project-list
# Komutların stdout'u stderr'e gider; tek satır JSON yalnızca fd 3'e yazılır.
exec 3>&1 1>&2

log() { logger -t gate -- "$SCRIPT: $*" 2>/dev/null || true; }
die() { log "hata: $*"; printf '%s: %s\n' "$SCRIPT" "$*" >&2; exit 1; }

USER_RE='^[a-z][a-z0-9_-]{1,31}$'
MODULE_RE='^[a-z][a-z0-9-]{1,31}$'
PROJECTS_ROOT=/srv/projects
MAX_ENTRIES=500

# Sabit kod (kullanıcı girdisi içermez). Her yol parçası O_NOFOLLOW ile açılır, böylece sembolik bağla proje dışına çıkılamaz.
PY_LIST='import json, os, stat, sys
root, rel, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
fd = os.open(root, flags)
for part in [p for p in rel.split("/") if p]:
    if part in (".", ".."):
        raise SystemExit("geçersiz yol")
    nxt = os.open(part, flags, dir_fd=fd)
    os.close(fd)
    fd = nxt
items = []
truncated = False
with os.scandir(fd) as it:
    for e in it:
        name = e.name
        if name == ".git":
            continue
        try:
            name.encode("utf-8", "strict")
            st = e.stat(follow_symlinks=False)
        except (UnicodeError, OSError):
            continue
        if stat.S_ISDIR(st.st_mode):
            items.append({"n": name, "t": "d"})
        elif stat.S_ISLNK(st.st_mode):
            items.append({"n": name, "t": "l"})
        elif stat.S_ISREG(st.st_mode):
            items.append({"n": name, "t": "f", "s": st.st_size})
items.sort(key=lambda i: (i["t"] != "d", i["n"].lower()))
if len(items) > limit:
    items = items[:limit]
    truncated = True
sys.stdout.write(json.dumps({"ok": True, "entries": items, "truncated": truncated}, ensure_ascii=True, separators=(",", ":")))
'

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

has_read_acl() {
  local d="$1" u="$2" line
  while IFS= read -r line; do
    if [[ "$line" == "user:$u:r-x" || "$line" == "user:$u:r-x"[[:space:]]* ]]; then return 0; fi
  done < <(getfacl --absolute-names --omit-header --physical -- "$d" 2>/dev/null || true)
  return 1
}

[[ $# -eq 2 || $# -eq 3 ]] || die "kullanım: project-list.sh <user> <project> [relpath]"
u="$1"
project="$2"
rel="${3:-}"
[[ "$u" =~ $USER_RE ]] || die "geçersiz kullanıcı adı"
if is_protected "$u"; then die "korunan hesap: $u"; fi
[[ "$project" =~ $MODULE_RE ]] || die "geçersiz proje adı"
id -u "$u" >/dev/null 2>&1 || die "kullanıcı yok: $u"
(( ${#rel} <= 1024 )) || die "yol çok uzun"
if [[ "$rel" == /* || "$rel" =~ [[:cntrl:]] ]]; then die "geçersiz yol"; fi
case "/$rel/" in
  */../*|*/./*|*//*) if [[ -n "$rel" ]]; then die "geçersiz yol"; fi ;;
esac

dir="$PROJECTS_ROOT/$project"
if [[ -L "$PROJECTS_ROOT" || -L "$dir" || ! -d "$dir" ]]; then die "proje yok: $project"; fi
if ! { getent group "mod-$project" >/dev/null && in_group "$u" "mod-$project"; } && ! has_read_acl "$dir" "$u"; then
  die "yetki yok: $project"
fi
command -v python3 >/dev/null 2>&1 || die "python3 bulunamadı"
cd /

out="$(python3 -I -c "$PY_LIST" "$dir" "$rel" "$MAX_ENTRIES")" || die "listelenemedi"
[[ "$out" == '{"ok":true,'* && "$out" == *'}' ]] || die "geçersiz çıktı"
printf '%s\n' "$out" >&3
