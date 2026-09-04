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
for volume in /Volumes/[Cc]haron*; do
  [ -e "$volume" ] && hdiutil detach "$volume" >/dev/null 2>&1 && echo "Volume éjecté : $volume"
done
# Le nettoyage balaie TOUT le dossier bundle, pas seulement macos/ : une image
# temporaire peut être laissée ailleurs selon l'endroit où bundle_dmg.sh
# s'interrompt, et il suffit qu'il en reste une pour que chaque tentative
# suivante échoue à son tour. C'est ce qui transforme un échec isolé en boucle.
BUNDLE_DIR="$(dirname "$0")/../src-tauri/target/release/bundle"
find "$BUNDLE_DIR" -name "rw.*.dmg" -delete 2>/dev/null || true

npx tauri build --config src-tauri/tauri.release.conf.json

# Tag de release, créé puis poussé automatiquement (branche courante + tag) :
# le push du tag déclenche le build Windows (workflow windows.yml) qui attache
# l'installeur à la release GitHub — deploy.sh le récupérera tout seul.
#
# RETAG=1 : cas du rebuild sur la MÊME version (par ex. un deploy relancé sans
# avoir bumpé le numéro). Un tag qui existe déjà ne bouge jamais tout seul —
# le push d'un tag inchangé ne déclenche rien côté CI — donc sans ce drapeau
# le rebuild part pour rien : nouveau binaire, mais tag et CI Windows figés
# sur l'ancien commit. RETAG=1 supprime le tag local ET distant puis le
# recrée sur HEAD, en forçant le push.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -c "import json;print(json.load(open('$DIR/src-tauri/tauri.conf.json'))['version'])")"
TAG="v$VERSION"
TAG_EXISTS="$(git -C "$DIR" rev-parse "$TAG" >/dev/null 2>&1 && echo 1 || echo 0)"
if [ "$TAG_EXISTS" = "1" ] && [ "${RETAG:-0}" = "1" ]; then
  git -C "$DIR" tag -d "$TAG" >/dev/null 2>&1 || true
  git -C "$DIR" push origin ":refs/tags/$TAG" >/dev/null 2>&1 || true
  echo "Tag $TAG retiré (local + distant), recréé sur ce commit."
  TAG_EXISTS=0
fi
if [ "$TAG_EXISTS" = "1" ]; then
  echo "Tag $TAG déjà présent (rebuild de la même version) — RETAG=1 pour le repousser."
else
  git -C "$DIR" tag "$TAG"
  echo "Tag $TAG créé."
fi
if git -C "$DIR" push origin HEAD "$TAG"; then
  echo "Poussé : branche courante + $TAG → la CI Windows démarre (~20 min)."
else
  echo "⚠ Push impossible (hors-ligne ? remote ?) — à faire à la main : git push origin HEAD $TAG" >&2
fi
