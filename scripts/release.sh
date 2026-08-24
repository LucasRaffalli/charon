#!/usr/bin/env bash
# Build de release signé pour l'updater.
#
# Préconfig (une seule fois) : stocke le mot de passe de la clé privée dans
# le trousseau macOS —
#   security add-generic-password -a charon-updater -s charon-updater-password -w
# (il demandera le mot de passe ; rien n'est écrit dans le dépôt).
#
# Ensuite : `npm run release` suffit.
set -euo pipefail

KEY_FILE="$HOME/.tauri/charon-updater.key"
if [ ! -f "$KEY_FILE" ]; then
  echo "Clé privée introuvable : $KEY_FILE" >&2
  exit 1
fi

# Le bundle du build lit le CONTENU de la clé (TAURI_SIGNING_PRIVATE_KEY),
# pas le chemin — d'où le `cat`.
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"

# Mot de passe récupéré du trousseau (jamais stocké dans le dépôt).
PWD_FROM_KEYCHAIN="$(security find-generic-password -a charon-updater -s charon-updater-password -w 2>/dev/null || true)"
if [ -z "$PWD_FROM_KEYCHAIN" ]; then
  echo "Mot de passe de signature absent du trousseau." >&2
  echo "Stocke-le une fois :" >&2
  echo "  security add-generic-password -a charon-updater -s charon-updater-password -w" >&2
  exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$PWD_FROM_KEYCHAIN"

# bundle_dmg.sh échoue si un volume « charon » est déjà monté (dmg de test
# ouvert) ou si une image temporaire rw.*.dmg traîne d'un build interrompu :
# on nettoie systématiquement avant de builder.
for volume in /Volumes/charon*; do
  [ -e "$volume" ] && hdiutil detach "$volume" >/dev/null 2>&1 && echo "Volume éjecté : $volume"
done
rm -f "$(dirname "$0")/../src-tauri/target/release/bundle/macos"/rw.*.dmg

npx tauri build --config src-tauri/tauri.release.conf.json

# Tag de release, créé puis poussé automatiquement (branche courante + tag) :
# le push du tag déclenche le build Windows (workflow windows.yml) qui attache
# l'installeur à la release GitHub — deploy.sh le récupérera tout seul.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -c "import json;print(json.load(open('$DIR/src-tauri/tauri.conf.json'))['version'])")"
TAG="v$VERSION"
if git -C "$DIR" rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG déjà présent (rebuild de la même version)."
else
  git -C "$DIR" tag "$TAG"
  echo "Tag $TAG créé."
fi
if git -C "$DIR" push origin HEAD "$TAG"; then
  echo "Poussé : branche courante + $TAG → la CI Windows démarre (~20 min)."
else
  echo "⚠ Push impossible (hors-ligne ? remote ?) — à faire à la main : git push origin HEAD $TAG" >&2
fi
