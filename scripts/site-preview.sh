#!/usr/bin/env bash
# Aperçu local de la page de téléchargement, à l'identique du VPS.
#
# La page est écrite pour un serveur qui sert TOUT À PLAT : le fond, les
# polices et les icônes vivent à côté d'index.html une fois déployés, alors
# qu'ils sont rangés par nature dans le dépôt (site/assets, src/assets/fonts,
# src-tauri/icons). Ouvrir site/index.html directement donne donc une page
# sans fond ni typographie, et fait douter d'un problème qui n'existe pas.
#
# Ce script reconstitue l'arborescence de destination dans un dossier
# temporaire, puis la sert. Usage : npm run site:preview
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4310}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"

# On régénère la page pour voir le changelog dans son état courant. Les noms
# des fichiers sont ceux qu'aura la release, même s'ils n'existent pas encore :
# seuls les liens en dépendent, et l'aperçu doit montrer la page COMPLÈTE,
# bouton Windows et note SmartScreen compris. Sans l'installeur en argument,
# `make-site.sh` les omet et l'aperçu ment par omission.
bash "$ROOT/scripts/make-site.sh" \
  "Charon_${VERSION}_aarch64.dmg" \
  "Charon_${VERSION}_x64-setup.exe" >/dev/null

cp "$ROOT/site/index.html" "$OUT/"
cp "$ROOT/site/assets/web_bg.png" "$ROOT/site/assets/web_bg_effect.png" "$OUT/"
cp "$ROOT/src/assets/fonts/Satoshi-400.woff2" \
   "$ROOT/src/assets/fonts/Satoshi-700.woff2" \
   "$ROOT/src/assets/fonts/Satoshi-900.woff2" "$OUT/"
# Les illustrations du journal, servies à plat comme sur le VPS.
python3 - "$ROOT" "$OUT" <<'PY'
import json, os, shutil, sys
repo, out = sys.argv[1], sys.argv[2]
for e in json.load(open(f"{repo}/src/assets/changelog.json", encoding="utf-8")):
    rel = e.get("cover")
    if rel and os.path.isfile(os.path.join(repo, "src", rel)):
        shutil.copy(os.path.join(repo, "src", rel), out)
PY

cp "$ROOT/src-tauri/icons/32x32.png" "$OUT/favicon.png"
cp "$ROOT/src-tauri/icons/128x128@2x.png" "$OUT/apple-touch-icon.png"

echo "Page de téléchargement v$VERSION sur http://localhost:$PORT"
echo "(Ctrl+C pour arrêter)"
command -v open >/dev/null && (sleep 1 && open "http://localhost:$PORT") &
cd "$OUT" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1
