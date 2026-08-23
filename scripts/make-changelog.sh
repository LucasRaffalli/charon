#!/usr/bin/env bash
# Génère src/app/generated/changelog.ts depuis les tags git (v*) :
# une entrée par version, notes = sujets des commits depuis le tag précédent.
# Si la version de tauri.conf.json n'est pas encore taguée, elle devient
# l'entrée la plus récente (commits depuis le dernier tag).
#
# Lancé automatiquement par les hooks npm prestart/prebuild (donc par
# `npm run dev`, `npm run build` et les builds Tauri). Le fichier généré est
# GITIGNORÉ — il fait partie du bundle (l'historique survit aux mises à jour)
# mais jamais du dépôt. Regénération manuelle : `npm run changelog`.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/src/app/generated/changelog.ts"
mkdir -p "$(dirname "$OUT")"

python3 - "$DIR" "$OUT" <<'EOF'
import datetime
import json
import subprocess
import sys

repo, out = sys.argv[1:3]


def git(*args):
    return subprocess.run(
        ["git", "-C", repo, *args], capture_output=True, text=True, check=True
    ).stdout


def notes_in(rng):
    lines = git("log", rng, "--no-merges", "--pretty=format:%s").splitlines()
    seen, notes = set(), []
    for line in lines:
        line = line.strip()
        if line and line not in seen:
            seen.add(line)
            notes.append(line)
    return notes


tags = [t for t in git("tag", "--list", "v*", "--sort=v:refname").splitlines() if t]
version = json.load(open(f"{repo}/src-tauri/tauri.conf.json"))["version"]
current_tag = f"v{version}"

entries = []
prev = None
for tag in tags:
    rng = f"{prev}..{tag}" if prev else tag
    date = git("log", "-1", "--format=%ad", "--date=format:%Y-%m-%d", tag).strip()
    entries.append({"version": tag[1:], "date": date, "notes": notes_in(rng)})
    prev = tag

# Version en préparation (pas encore taguée) : commits depuis le dernier tag.
if current_tag not in tags:
    rng = f"{prev}..HEAD" if prev else "HEAD"
    notes = notes_in(rng)
    if notes:
        entries.append(
            {
                "version": version,
                "date": datetime.date.today().isoformat(),
                "notes": notes,
            }
        )

entries.reverse()  # plus récent d'abord

body = json.dumps(entries, ensure_ascii=False, indent=2)
with open(out, "w", encoding="utf-8") as f:
    f.write(
        "// Généré par scripts/make-changelog.sh — NE PAS ÉDITER À LA MAIN.\n"
        "// Régénéré à chaque release (npm run release) depuis les tags git ;\n"
        "// embarqué dans le bundle : l'historique survit aux mises à jour.\n\n"
        "export interface ChangelogEntry {\n"
        "  version: string;\n"
        "  date: string;\n"
        "  notes: string[];\n"
        "}\n\n"
        f"export const CHANGELOG: ChangelogEntry[] = {body};\n"
    )
print(f"changelog.ts généré ({len(entries)} version(s)).")
EOF
