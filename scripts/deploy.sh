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
# (publiée par le workflow windows.yml, déclenché par le push du tag dans
# release.sh). La CI prend ~20 min : on sonde toutes les 60 s jusqu'à 30 min
# pour tout publier en un seul deploy. WAIT_WINDOWS=0 pour ne pas attendre
# (deploy macOS seul, relançable plus tard pour ajouter Windows).
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
# On cherche l'installeur DE CETTE VERSION précisément : un reliquat d'une
# release précédente dans dist-windows/ ferait croire que Windows est prêt, on
# sauterait le téléchargement, et le manifeste sortirait sans Windows.
WIN_NAME="Charon_${VERSION}_x64-setup.exe"
WIN_EXE=""
if [ -f "$ROOT/dist-windows/$WIN_NAME" ]; then
  WIN_EXE="$ROOT/dist-windows/$WIN_NAME"
fi
if [ -z "$WIN_EXE" ]; then
  WIN_URL="https://github.com/LucasRaffalli/charon/releases/download/v$VERSION"
  mkdir -p "$ROOT/dist-windows"
  DEADLINE=$(( $(date +%s) + 1800 ))
  while :; do
    if curl -fsSL -o "$ROOT/dist-windows/$WIN_NAME" "$WIN_URL/$WIN_NAME" &&
       curl -fsSL -o "$ROOT/dist-windows/$WIN_NAME.sig" "$WIN_URL/$WIN_NAME.sig"; then
      echo "Installeur Windows récupéré depuis la release GitHub v$VERSION."
      WIN_EXE="$ROOT/dist-windows/$WIN_NAME"
      break
    fi
    rm -f "$ROOT/dist-windows/$WIN_NAME" "$ROOT/dist-windows/$WIN_NAME.sig"
    if [ "${WAIT_WINDOWS:-1}" = "0" ] || [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "(pas d'installeur Windows dans la release v$VERSION — deploy macOS seul ;"
      echo " vérifier l'onglet Actions, puis relancer npm run deploy pour ajouter Windows)"
      break
    fi
    echo "CI Windows en cours (release v$VERSION)… nouvel essai dans 60 s [WAIT_WINDOWS=0 pour publier sans attendre]"
    sleep 60
  done
fi

# 3. générer le manifeste (signature + url dedans ; inclut Windows si présent)
"$HERE/make-latest-json.sh" "$PUBLIC_URL" > "$ROOT/latest.json"

# 4. installeur .dmg pour les premières installations (lien à partager)
DMG="$(ls "$ROOT/src-tauri/target/release/bundle/dmg"/*.dmg 2>/dev/null | head -1)"

# 5. page de téléchargement (version + changelog curaté + liens .dmg/.exe)
"$HERE/make-site.sh" "${DMG:+$(basename "$DMG")}" "${WIN_EXE:+$(basename "$WIN_EXE")}"

# 5bis. cask Homebrew (tap séparé — version + sha256 du .dmg), puis commit
# et push automatiques du tap s'il a changé.
"$HERE/make-cask.sh"
TAP_DIR="${TAP_DIR:-$ROOT/../homebrew-charon}"
if [ -d "$TAP_DIR/.git" ] && [ -n "$(git -C "$TAP_DIR" status --porcelain)" ]; then
  git -C "$TAP_DIR" add -A
  git -C "$TAP_DIR" commit -m "charon $VERSION"
  if git -C "$TAP_DIR" push; then
    echo "✓ Tap Homebrew poussé (charon $VERSION)."
  else
    echo "⚠ Push du tap impossible — à faire à la main : cd \"$TAP_DIR\" && git push" >&2
  fi
fi

# 6. envoyer manifeste + archive (+ dmg) + page + assets sur le VPS
# (le fond vient de site/assets, les fonts de src/assets : source unique)
echo "Upload vers $VPS_HOST:$VPS_DIR …"
scp -P "$VPS_PORT" \
  "$ROOT/latest.json" \
  "$ROOT/site/index.html" \
  "$ROOT/site/assets/web_bg.png" \
  "$ROOT/site/assets/web_bg_effect.png" \
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
