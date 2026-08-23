#!/usr/bin/env bash
# Génère site/index.html (page de téléchargement) depuis le template :
# version depuis tauri.conf.json, changelog depuis le fichier CURATÉ
# src/assets/changelog.json (rédigé à la main), lien du .dmg.
#
# Usage : make-site.sh [nom-du-dmg]   (défaut : charon_<version>_aarch64.dmg)
# Appelé par deploy.sh après le build ; le fichier généré est gitignoré.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DMG_NAME="${1:-}"

python3 - "$DIR" "$DMG_NAME" <<'EOF'
import datetime
import html
import json
import sys

repo, dmg_name = sys.argv[1], sys.argv[2]

version = json.load(open(f"{repo}/src-tauri/tauri.conf.json"))["version"]
today = datetime.date.today().isoformat()
if not dmg_name:
    dmg_name = f"charon_{version}_aarch64.dmg"

# --- Changelog curaté (même source que l'app et latest.json) ---
entries = json.load(open(f"{repo}/src/assets/changelog.json", encoding="utf-8"))

# --- Rendu HTML (tout est échappé : les sujets de commits sont du texte) ---
blocks = []
for i, e in enumerate(entries):
    latest = '<span class="release-latest">dernière</span>' if i == 0 else ""
    items = "\n".join(f"        <li>{html.escape(n)}</li>" for n in e["notes"])
    blocks.append(
        '      <div class="release">\n'
        '        <div class="release-head">\n'
        f'          <span class="release-version">{html.escape(e["version"])}</span>\n'
        f'          <span class="release-date">{html.escape(e["date"])}</span>\n'
        f"          {latest}\n"
        "        </div>\n"
        "        <ul>\n"
        f"{items}\n"
        "        </ul>\n"
        "      </div>"
    )
changelog_html = "\n".join(blocks) or '      <p class="release-date">Première version.</p>'

template = open(f"{repo}/site/index.template.html", encoding="utf-8").read()
page = (
    template.replace("{{VERSION}}", html.escape(version))
    .replace("{{DATE}}", html.escape(today))
    .replace("{{DMG_NAME}}", html.escape(dmg_name))
    .replace("{{CHANGELOG_HTML}}", changelog_html)
)

with open(f"{repo}/site/index.html", "w", encoding="utf-8") as f:
    f.write(page)
print(f"site/index.html généré (v{version}, {len(entries)} release(s), dmg: {dmg_name}).")
EOF
