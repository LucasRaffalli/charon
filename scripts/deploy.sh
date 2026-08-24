#!/usr/bin/env bash
# Déploiement d'une release vers le VPS, en une commande :
#   build signé → manifeste latest.json → upload (scp).
#
# Config (une fois) : copie scripts/deploy.env.example vers scripts/deploy.env
# et renseigne VPS_HOST + PUBLIC_URL. Le mot de passe de signature vient du
# trousseau (voir scripts/release.sh).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Dossier web sur le VPS (celui que tu as créé).
VPS_DIR="${VPS_DIR:-/var/www/release/charon}"
VPS_PORT="${VPS_PORT:-22}"
[ -f "$HERE/deploy.env" ] && source "$HERE/deploy.env"

: "${VPS_HOST:?Renseigne VPS_HOST dans scripts/deploy.env (ex. user@ton-vps)}"
: "${PUBLIC_URL:?Renseigne PUBLIC_URL dans scripts/deploy.env (ex. https://updates.tondomaine.fr/charon-release)}"

# 1. build signé (lit clé + mot de passe du trousseau)
bash "$HERE/release.sh"

# 2. localiser l'archive de mise à jour produite
BUNDLE="$ROOT/src-tauri/target/release/bundle/macos"
ARCHIVE="$(ls "$BUNDLE"/*.app.tar.gz 2>/dev/null | head -1)"
[ -n "$ARCHIVE" ] || { echo "Archive .app.tar.gz introuvable dans $BUNDLE" >&2; exit 1; }

# 2bis. installeur Windows (optionnel) : s'il n'est pas déjà dans
# dist-windows/, on le récupère depuis la release GitHub du tag courant
# (publiée par le workflow windows.yml). Absent = release macOS seule —
# relancer le deploy quand la CI aura fini pour ajouter Windows.
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
WIN_EXE="$(ls "$ROOT/dist-windows"/*-setup.exe 2>/dev/null | head -1 || true)"
if [ -z "$WIN_EXE" ]; then
  WIN_NAME="charon_${VERSION}_x64-setup.exe"
  WIN_URL="https://github.com/LucasRaffalli/charon/releases/download/v$VERSION"
  mkdir -p "$ROOT/dist-windows"
  if curl -fsSL -o "$ROOT/dist-windows/$WIN_NAME" "$WIN_URL/$WIN_NAME" &&
     curl -fsSL -o "$ROOT/dist-windows/$WIN_NAME.sig" "$WIN_URL/$WIN_NAME.sig"; then
    echo "Installeur Windows récupéré depuis la release GitHub v$VERSION."
    WIN_EXE="$ROOT/dist-windows/$WIN_NAME"
  else
    rm -f "$ROOT/dist-windows/$WIN_NAME" "$ROOT/dist-windows/$WIN_NAME.sig"
    echo "(pas d'installeur Windows : ni dist-windows/, ni release GitHub v$VERSION — deploy macOS seul)"
  fi
fi

# 3. générer le manifeste (signature + url dedans ; inclut Windows si présent)
"$HERE/make-latest-json.sh" "$PUBLIC_URL" > "$ROOT/latest.json"

# 4. installeur .dmg pour les premières installations (lien à partager)
DMG="$(ls "$ROOT/src-tauri/target/release/bundle/dmg"/*.dmg 2>/dev/null | head -1)"

# 5. page de téléchargement (version + changelog curaté + liens .dmg/.exe)
"$HERE/make-site.sh" "${DMG:+$(basename "$DMG")}" "${WIN_EXE:+$(basename "$WIN_EXE")}"

# 5bis. cask Homebrew (tap séparé — version + sha256 du .dmg) ; le push du
# tap reste manuel, le rappel est affiché en fin de script.
"$HERE/make-cask.sh"

# 6. envoyer manifeste + archive (+ dmg) + page + assets sur le VPS
# (le fond et les fonts de la page viennent de src/assets — source unique)
echo "Upload vers $VPS_HOST:$VPS_DIR …"
scp -P "$VPS_PORT" \
  "$ROOT/latest.json" \
  "$ROOT/site/index.html" \
  "$ROOT/src/assets/png/web_bg.png" \
  "$ROOT/src/assets/fonts/Satoshi-400.woff2" \
  "$ROOT/src/assets/fonts/Satoshi-700.woff2" \
  "$ROOT/src/assets/fonts/Satoshi-900.woff2" \
  "$ARCHIVE" ${DMG:+"$DMG"} ${WIN_EXE:+"$WIN_EXE"} "$VPS_HOST:$VPS_DIR/"

# Favicon de la page (icônes de l'app, renommées à l'upload).
scp -P "$VPS_PORT" "$ROOT/src-tauri/icons/32x32.png" "$VPS_HOST:$VPS_DIR/favicon.png"
scp -P "$VPS_PORT" "$ROOT/src-tauri/icons/128x128@2x.png" "$VPS_HOST:$VPS_DIR/apple-touch-icon.png"

echo "✓ Déployé : $PUBLIC_URL/latest.json"
echo "✓ Page de téléchargement : $PUBLIC_URL/"
if [ -n "$DMG" ]; then
  echo "✓ Installeur : $PUBLIC_URL/$(basename "$DMG")"
else
  echo "(pas de .dmg produit — premières installations via l'archive .app.tar.gz)"
fi
if [ -n "$WIN_EXE" ]; then
  echo "✓ Installeur Windows : $PUBLIC_URL/$(basename "$WIN_EXE")"
else
  echo "(pas d'installeur Windows dans dist-windows/ — release macOS seule)"
fi
echo "→ Si la cask a changé : commit + push du tap Homebrew (rappel plus haut)."
