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

exec npx tauri build --config src-tauri/tauri.release.conf.json
