#!/usr/bin/env bash
# Kullanım: sudo /srv/gate/scripts/admin-reset.sh [yonetici_adi] [--totp]
set -euo pipefail
umask 077
# Servis kullanıcısı ve node yolu kurulumda /etc/gate altına yazılır (install.sh); koda sabitlenmez.
RUN_AS="$(head -n1 /etc/gate/service-user 2>/dev/null || true)"
NODE="$(head -n1 /etc/gate/node-bin 2>/dev/null || true)"
BACKEND="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../backend" && pwd)"
[[ "$RUN_AS" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || { echo "HATA: /etc/gate/service-user okunamadı; önce install.sh çalıştırın." >&2; exit 1; }
[[ -x "$NODE" ]] || { echo "HATA: /etc/gate/node-bin okunamadı; önce install.sh çalıştırın." >&2; exit 1; }

if [ "$(id -u)" -ne 0 ] && [ "$(id -un)" != "$RUN_AS" ]; then
  echo "HATA: root ya da $RUN_AS olarak çalıştırın (sudo)." >&2
  exit 1
fi

cmd=(env GATE_DATA_DIR="${GATE_DATA_DIR:-$(cd -- "$BACKEND/.." && pwd)/data-real}" "$NODE" --no-warnings "$BACKEND/node_modules/tsx/dist/cli.mjs" "$BACKEND/src/tools/adminReset.ts" "$@")
cd "$BACKEND"
if [ "$(id -u)" -eq 0 ]; then
  exec runuser -u "$RUN_AS" -- "${cmd[@]}"
fi
exec "${cmd[@]}"
