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

# 4. envoyer manifeste + archive sur le VPS
echo "Upload vers $VPS_HOST:$VPS_DIR …"
scp -P "$VPS_PORT" "$ROOT/latest.json" "$ARCHIVE" "$VPS_HOST:$VPS_DIR/"

echo "✓ Déployé : $PUBLIC_URL/latest.json"
