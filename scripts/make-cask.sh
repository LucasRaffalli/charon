#!/usr/bin/env bash
# Génère la cask Homebrew du tap après le build du .dmg :
# version depuis tauri.conf.json, sha256 du .dmg, URL publique depuis deploy.env.
#
# Le tap est un dépôt git SÉPARÉ (github.com/LucasRaffalli/homebrew-charon),
# cloné à côté du projet (../homebrew-charon par défaut — TAP_DIR dans
# deploy.env pour changer). Après génération : commit + push du tap (manuel).
#
# Installation utilisateur : brew install --cask lucasraffalli/charon/charon
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
[ -f "$HERE/deploy.env" ] && source "$HERE/deploy.env"

: "${PUBLIC_URL:?Renseigne PUBLIC_URL dans scripts/deploy.env}"
TAP_DIR="${TAP_DIR:-$ROOT/../homebrew-charon}"

if [ ! -d "$TAP_DIR" ]; then
  echo "Tap introuvable ($TAP_DIR) — cask non générée." >&2
  echo "Clone-le : git clone https://github.com/LucasRaffalli/homebrew-charon \"$TAP_DIR\"" >&2
  exit 0
fi

DMG="$(ls "$ROOT/src-tauri/target/release/bundle/dmg"/*.dmg 2>/dev/null | head -1)"
[ -n "$DMG" ] || { echo "Aucun .dmg — lancer le build d'abord." >&2; exit 1; }

VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
SHA256="$(shasum -a 256 "$DMG" | awk '{print $1}')"

# NB : #{version} est de l'interpolation Ruby, résolue par Homebrew — seul
# ${VERSION}/${SHA256}/${PUBLIC_URL} sont substitués ici.
mkdir -p "$TAP_DIR/Casks"
cat > "$TAP_DIR/Casks/charon.rb" <<RUBY
cask "charon" do
  version "${VERSION}"
  sha256 "${SHA256}"

  url "${PUBLIC_URL}/charon_#{version}_aarch64.dmg"
  name "Charon"
  desc "Client SFTP/FTPS/FTP privé pour macOS"
  homepage "${PUBLIC_URL}/"

  # L'app embarque son propre updater — brew upgrade n'a rien à faire.
  auto_updates true
  depends_on arch: :arm64

  app "charon.app"

  # App non notarisée : sans ça, Gatekeeper affiche « charon est endommagé ».
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-cr", "#{appdir}/charon.app"]
  end

  uninstall quit: "com.aegis.charon"

  zap trash: [
    "~/Library/Application Support/com.aegis.charon",
    "~/Library/Caches/com.aegis.charon",
    "~/Library/Preferences/com.aegis.charon.plist",
    "~/Library/Saved Application State/com.aegis.charon.savedState",
    "~/Library/WebKit/com.aegis.charon",
  ]
end
RUBY

echo "Cask générée : $TAP_DIR/Casks/charon.rb (v$VERSION, sha256 ${SHA256:0:12}…)"
echo "→ à publier : cd \"$TAP_DIR\" && git add -A && git commit -m \"charon $VERSION\" && git push"
