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

# --- Windows (optionnel) : installeur NSIS + signature, produits par la CI
# (workflow windows.yml) et dézippés dans dist-windows/. Absents = latest.json
# macOS seul, comme avant.
# On vise le nom exact de la version courante : un installeur d'une release
# précédente qui traîne dans dist-windows/ est ignoré au lieu d'être publié
# ou de faire échouer la génération.
WIN_NAME=""
WIN_SIGNATURE=""
WIN_EXE="$DIR/dist-windows/charon_${VERSION}_x64-setup.exe"
if [ -f "$WIN_EXE" ]; then
  if [ ! -f "$WIN_EXE.sig" ]; then
    echo "Attention : signature absente ($WIN_EXE.sig) — Windows exclu de latest.json." >&2
  else
    WIN_NAME="$(basename "$WIN_EXE")"
    WIN_SIGNATURE="$(cat "$WIN_EXE.sig")"
  fi
else
  echo "Attention : aucun installeur Windows v$VERSION dans dist-windows/ — latest.json macOS seul." >&2
fi

# --- Notes de version : depuis le changelog CURATÉ (src/assets/changelog.json,
# rédigé à la main à chaque feature) — jamais depuis les messages de commit,
# qui peuvent contenir des détails internes. Affichées dans
# Réglages -> Mises à jour avant installation.
NOTES="$(CHANGELOG="$DIR/src/assets/changelog.json" VERSION="$VERSION" python3 - <<'PYEOF'
import json
import os

entries = json.load(open(os.environ["CHANGELOG"], encoding="utf-8"))
version = os.environ["VERSION"]
entry = next((e for e in entries if e["version"] == version), None)
if entry:
    print("\n".join(f"- {n}" for n in entry["notes"]))
PYEOF
)"
if [ -z "$NOTES" ]; then
  echo "Attention : aucune entrée '$VERSION' dans src/assets/changelog.json — notes vides." >&2
fi

NOTES="$NOTES" WIN_NAME="$WIN_NAME" WIN_SIGNATURE="$WIN_SIGNATURE" \
  python3 - "$VERSION" "$SIGNATURE" "$BASE_URL/$NAME" "$BASE_URL" <<'EOF'
import datetime
import json
import os
import sys

version, signature, url, base_url = sys.argv[1:5]
notes = os.environ.get("NOTES", "")

platforms = {
    "darwin-aarch64": {"signature": signature, "url": url},
    "darwin-x86_64": {"signature": signature, "url": url},
}
win_name = os.environ.get("WIN_NAME", "")
if win_name:
    platforms["windows-x86_64"] = {
        "signature": os.environ["WIN_SIGNATURE"],
        "url": f"{base_url}/{win_name}",
    }

print(
    json.dumps(
        {
            "version": version,
            "notes": notes,
            "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
            "platforms": platforms,
        },
        indent=2,
    )
)
EOF
