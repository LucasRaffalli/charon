#!/usr/bin/env bash
# Génère site/index.html (page de téléchargement) depuis le template :
# version depuis tauri.conf.json, changelog depuis le fichier CURATÉ
# src/assets/changelog.json (rédigé à la main), lien du .dmg.
#
# Usage : make-site.sh [nom-du-dmg] [nom-du-exe-windows]
# (défaut dmg : charon_<version>_aarch64.dmg ; exe vide = pas de bouton Windows)
# Appelé par deploy.sh après le build ; le fichier généré est gitignoré.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DMG_NAME="${1:-}"
EXE_NAME="${2:-}"

python3 - "$DIR" "$DMG_NAME" "$EXE_NAME" <<'EOF'
import datetime
import html
import json
import sys

repo, dmg_name, exe_name = sys.argv[1], sys.argv[2], sys.argv[3]

version = json.load(open(f"{repo}/src-tauri/tauri.conf.json"))["version"]
# Les dates se lisent en toutes lettres, comme dans l'application : le format
# ISO est fait pour trier, pas pour être lu. Les mois sont écrits ici plutôt
# que confiés à la locale du système, qui n'est pas garantie sur un runner.
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin",
        "juillet", "août", "septembre", "octobre", "novembre", "décembre"]


def en_toutes_lettres(iso):
    try:
        d = datetime.date.fromisoformat(iso)
    except ValueError:
        return iso
    return f"{d.day} {MOIS[d.month - 1]} {d.year}"


today = en_toutes_lettres(datetime.date.today().isoformat())
if not dmg_name:
    dmg_name = f"Charon_{version}_aarch64.dmg"

# --- Changelog curaté (même source que l'app et latest.json) ---
entries = json.load(open(f"{repo}/src/assets/changelog.json", encoding="utf-8"))

# --- Rendu HTML (tout est échappé : les sujets de commits sont du texte) ---
blocks = []
for i, e in enumerate(entries):
    latest = '<span class="release-latest">dernière</span>' if i == 0 else ""
    # Une note est {kind, text} ; les anciens journaux la donnaient en chaîne.
    def note_text(n):
        return n["text"] if isinstance(n, dict) else n

    # Groupées par nature et comptées, comme dans l'application : cinquante
    # notes à la suite ne disent pas par où commencer.
    def note_kind(n):
        return n.get("kind", "new") if isinstance(n, dict) else "new"

    groups_html = []
    for kind, one, many in (
        ("new", "nouveauté", "nouveautés"),
        ("better", "amélioration", "améliorations"),
        ("fixed", "correctif", "correctifs"),
    ):
        of = [n for n in e["notes"] if note_kind(n) == kind]
        if not of:
            continue
        items = "\n".join(f"            <li>{html.escape(note_text(n))}</li>" for n in of)
        label = many if len(of) > 1 else one
        groups_html.append(
            '        <section class="release-group">\n'
            f"          <h3>{len(of)} {label}</h3>\n"
            f'          <ul class="g-{kind}">\n{items}\n          </ul>\n'
            "        </section>"
        )
    groups = '        <div class="release-groups">\n' + "\n".join(groups_html) + "\n        </div>"

    # Le nom porte, le numéro l'accompagne : même hiérarchie que dans l'app.
    title = e.get("title")
    name = f'          <span class="release-name">{html.escape(title)}</span>\n' if title else ""

    # L'illustration : le site sert tout à plat, seul le nom de fichier compte.
    cover = ""
    if e.get("cover"):
        src = html.escape(e["cover"].rsplit("/", 1)[-1])
        cover = f'        <div class="release-cover"><img src="{src}" alt="" loading="lazy" /></div>\n'

    blocks.append(
        '      <div class="release">\n'
        '        <div class="release-head">\n'
        f"{name}"
        f'          <span class="release-version">{html.escape(e["version"])}</span>\n'
        f'          <span class="release-date">{html.escape(en_toutes_lettres(e["date"]))}</span>\n'
        f"          {latest}\n"
        "        </div>\n"
        f"{cover}"
        f"{groups}\n"
        "      </div>"
    )
changelog_html = "\n".join(blocks) or '      <p class="release-date">Première version.</p>'

# --- Windows (optionnel) : bouton + note SmartScreen si un .exe est fourni ---
windows_btn = ""
windows_note = ""
if exe_name:
    e = html.escape(exe_name)
    windows_btn = f'<a class="btn btn-alt" href="{e}" download>Télécharger pour Windows</a>'
    windows_note = (
        '<div class="note note--win">\n'
        '      <span class="note__ic" aria-hidden="true"></span>\n'
        "      <div><strong class=\"note__title\">Windows : l'installeur n'est pas signé</strong>\n"
        "      SmartScreen affichera « Windows a protégé votre ordinateur ».\n"
        "      Clique sur <strong>Informations complémentaires → Exécuter quand\n"
        "      même</strong> (une seule fois, les mises à jour passent ensuite\n"
        "      par l'app).</div>\n"
        "    </div>"
    )

template = open(f"{repo}/site/index.template.html", encoding="utf-8").read()
page = (
    template.replace("{{VERSION}}", html.escape(version))
    .replace("{{DATE}}", html.escape(today))
    .replace("{{DMG_NAME}}", html.escape(dmg_name))
    .replace("{{WINDOWS_BTN}}", windows_btn)
    .replace("{{WINDOWS_NOTE}}", windows_note)
    .replace("{{CHANGELOG_HTML}}", changelog_html)
)

with open(f"{repo}/site/index.html", "w", encoding="utf-8") as f:
    f.write(page)
print(f"site/index.html généré (v{version}, {len(entries)} release(s), dmg: {dmg_name}).")
EOF
