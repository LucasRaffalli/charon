// Ce qui reste à traduire, par fichier.
//
// Une migration i18n de plusieurs centaines de chaînes ne se termine que si
// l'on peut voir où elle en est : sans ce compteur, elle s'arrête au premier
// écran converti et personne ne sait ce qui manque. Rien ici n'échoue — c'est
// un état des lieux, pas une barrière.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = process.env.REPO ?? path.join(__dirname, '..');
const SRC = path.join(REPO, 'src/app');

/** Un mot français courant : le signe qu'une chaîne s'adresse à quelqu'un. */
const FRENCH =
  /\b(le|la|les|un|une|des|du|au|aux|est|sont|pas|dans|pour|avec|sur|ce|cette|ces|aucun|aucune|impossible|erreur|serveur|dossier|fichier|fichiers|connexion|ouvrir|fermer|supprimer|copier|coller|envoyer|télécharger|chemin|nom|réglages|panneau|onglet)\b/i;

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (/\.(ts|html)$/.test(entry.name) && !full.includes('/lang/')) {
      files.push(full);
    }
  }
})(SRC);

const rows = [];
let total = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  // Les commentaires ne s'affichent pas : ils restent en français, et c'est
  // très bien — c'est la langue dans laquelle ce code se raconte.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');

  let hits = 0;
  if (file.endsWith('.html')) {
    for (const m of code.matchAll(/>\s*([^<>{}][^<>]{2,})\s*</g)) {
      if (FRENCH.test(m[1])) hits++;
    }
    for (const m of code.matchAll(/(?:title|placeholder|aria-label|label)="([^"{}]{3,})"/g)) {
      if (FRENCH.test(m[1])) hits++;
    }
  } else {
    for (const m of code.matchAll(/['"`]([^'"`\n]{3,})['"`]/g)) {
      if (FRENCH.test(m[1])) hits++;
    }
  }
  if (hits) {
    rows.push([hits, path.relative(REPO, file)]);
    total += hits;
  }
}

rows.sort((a, b) => b[0] - a[0]);
for (const [hits, file] of rows.slice(0, 25)) {
  console.log(String(hits).padStart(4), file);
}
if (rows.length > 25) {
  console.log(`  … et ${rows.length - 25} autres fichiers`);
}
console.log(`\n${total} chaînes restantes dans ${rows.length} fichiers.`);
