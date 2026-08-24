/**
 * Entrée du changelog curaté (`src/assets/changelog.json`), LA source unique :
 * affiché dans Réglages → Mises à jour, injecté dans latest.json à la release
 * (make-latest-json.sh) et rendu sur la page de téléchargement (make-site.sh).
 *
 * Rédigé à la main à chaque feature (texte destiné aux utilisateurs), jamais
 * dérivé des messages de commit, qui peuvent contenir des détails internes.
 */
export interface ChangelogEntry {
  version: string;
  date: string;
  notes: string[];
}
