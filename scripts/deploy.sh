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

# 3. générer le manifeste (signature + url dedans)
"$HERE/make-latest-json.sh" "$PUBLIC_URL" > "$ROOT/latest.json"

# 4. installeur .dmg pour les premières installations (lien à partager)
DMG="$(ls "$ROOT/src-tauri/target/release/bundle/dmg"/*.dmg 2>/dev/null | head -1)"

# 5. page de téléchargement (version + changelog curaté + lien du .dmg)
"$HERE/make-site.sh" "${DMG:+$(basename "$DMG")}"

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
  "$ARCHIVE" ${DMG:+"$DMG"} "$VPS_HOST:$VPS_DIR/"

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
