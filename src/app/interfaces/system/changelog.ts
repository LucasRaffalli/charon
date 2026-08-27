/**
 * Ce qu'une note raconte : une nouveauté, une amélioration, une correction.
 *
 * Le classement n'est pas décoratif : personne ne lit une liste de trente
 * lignes, mais tout le monde cherche « qu'est-ce qui est nouveau » ou « est-ce
 * que mon problème est corrigé ».
 */
export type ChangeKind = 'new' | 'better' | 'fixed';

/** Une ligne du journal des versions. */
export interface ChangeNote {
  kind: ChangeKind;
  text: string;
}

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
  /** Ce que la version apporte, en une formule. Facultatif. */
  title?: string;
  notes: ChangeNote[];
}
