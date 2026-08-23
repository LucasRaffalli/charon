#!/usr/bin/env bash
# Génère le latest.json de l'updater après `npm run tauri build`.
#
# Usage :
#   TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/charon-updater.key npm run tauri build
#   scripts/make-latest-json.sh https://ton-vps.exemple/charon > latest.json
#
# Puis téléverser sur le VPS : latest.json + l'archive .app.tar.gz
# (l'URL de base doit correspondre à l'endpoint de tauri.conf.json).
set -euo pipefail

BASE_URL="${1:?usage: make-latest-json.sh <url-de-base>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$DIR/src-tauri/target/release/bundle/macos"

ARCHIVE="$(ls "$BUNDLE"/*.app.tar.gz 2>/dev/null | head -1)"
if [ -z "$ARCHIVE" ]; then
  echo "Aucune archive .app.tar.gz dans $BUNDLE — lancer npm run tauri build d'abord." >&2
  exit 1
fi
if [ ! -f "$ARCHIVE.sig" ]; then
  echo "Signature absente ($ARCHIVE.sig) — le build doit être signé (TAURI_SIGNING_PRIVATE_KEY_PATH)." >&2
  exit 1
fi

VERSION="$(python3 -c "import json;print(json.load(open('$DIR/src-tauri/tauri.conf.json'))['version'])")"
SIGNATURE="$(cat "$ARCHIVE.sig")"
NAME="$(basename "$ARCHIVE")"

# --- Notes de version : générées depuis git (aucun fichier à maintenir). ---
# Un commit = une feature (workflow du dépôt) → les sujets des commits depuis
# le tag de la release précédente SONT le changelog. Affichées dans
# Réglages -> Mises à jour avant installation.
CURRENT_TAG="v$VERSION"
# Tag précédent : le plus récent (tri par version) qui n'est pas la version courante.
PREV_TAG="$(git -C "$DIR" tag --list 'v*' --sort=-v:refname | grep -Fvx "$CURRENT_TAG" | head -1 || true)"
if git -C "$DIR" rev-parse "$CURRENT_TAG" >/dev/null 2>&1; then
  END="$CURRENT_TAG"   # release déjà taguée (npm run release) : borne exacte
else
  END="HEAD"
fi
if [ -n "$PREV_TAG" ]; then
  RANGE="$PREV_TAG..$END"
else
  RANGE="$END"         # première release : tout l'historique
fi
NOTES="$(git -C "$DIR" log "$RANGE" --no-merges --pretty=format:'- %s' 2>/dev/null || true)"
if [ -z "$NOTES" ]; then
  echo "Attention : aucun commit dans $RANGE — notes vides." >&2
fi

NOTES="$NOTES" python3 - "$VERSION" "$SIGNATURE" "$BASE_URL/$NAME" <<'EOF'
import datetime
import json
import os
import sys

version, signature, url = sys.argv[1:4]
notes = os.environ.get("NOTES", "")

print(
    json.dumps(
        {
            "version": version,
            "notes": notes,
            "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
            "platforms": {
                "darwin-aarch64": {"signature": signature, "url": url},
                "darwin-x86_64": {"signature": signature, "url": url},
            },
        },
        indent=2,
    )
)
EOF
