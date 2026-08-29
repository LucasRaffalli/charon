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
  /**
   * Comment essayer cette nouveauté, en une ou deux phrases : où cliquer, quel
   * raccourci.
   *
   * Facultatif, et ça doit le rester : une correction de bug n'a rien à faire
   * essayer, et une nouveauté qui se trouve toute seule n'a pas besoin qu'on
   * explique où elle est.
   */
  how?: string;
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
  /**
   * L'illustration de la version, chemin d'asset (`assets/webp/...`).
   * Facultative, et volontairement EMBARQUÉE plutôt que servie depuis un
   * hôte distant : la CSP n'autorise aucune source externe, la modale
   * s'ouvre au premier lancement après mise à jour (le pire moment pour
   * dépendre du réseau), et une cover de version ne change plus une fois
   * la version sortie. Format conseillé : WebP 1200 × 630, recadré en
   * bandeau à l'affichage.
   */
  cover?: string;
  notes: ChangeNote[];
}
