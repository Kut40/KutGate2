#!/usr/bin/env bash
# KutGate dağıtım paketi: yalnız kaynak, belge ve lisans girer (node_modules, dist, veri, anahtar girmez).
# Kullanım: bash scripts/paketle.sh [çıktı_dizini]
set -euo pipefail
kok="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
surum="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$kok/backend/package.json")"
dizin="${1:-$kok/cikti}"; mkdir -p -- "$dizin"; cikti="$dizin/kutgate-$surum.tar.gz"
liste="$(mktemp)"; trap 'rm -f -- "$liste"' EXIT
# İzin listesi: yalnız bu kök öğeler; içlerinden üretilen/gizli olanlar yol bazında (çapalı) dışlanır.
( cd "$kok" && find LICENSE README.md .gitignore backend frontend scripts docs \
    \( -path backend/node_modules -o -path frontend/node_modules -o -path frontend/dist -o -name __pycache__ \) -prune -o \
    \( -type f ! -name '*.key' ! -name '*.pem' ! -name '*.db' ! -name '.env' ! -name '.env.*' -print \) | LC_ALL=C sort ) > "$liste"
tar -C "$kok" --owner=0 --group=0 --numeric-owner --transform "s|^|kutgate-$surum/|" -czf "$cikti" -T "$liste"
gzip -t "$cikti"
printf '%s\n' "$cikti"
