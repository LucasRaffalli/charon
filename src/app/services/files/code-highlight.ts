export { languageFor } from '@app/services/files/language-of';

/**
 * Coloration Prism, chargée à la demande.
 *
 * Le module `prism-grammars` (Prism + 24 grammaires, ~100 Ko) est un chunk
 * paresseux : `ensureHighlighter()` le charge à la première ouverture d'un
 * fichier colorable, et `highlightCode` reste SYNCHRONE ensuite : la
 * superposition éditeur/coloration recolore à chaque frappe, elle ne peut
 * pas attendre une promesse. Tant que le module n'est pas là, la coloration
 * rend `null` et l'éditeur s'affiche en clair, ce qui est aussi son repli
 * quand un fichier crève le budget de temps.
 */
type PrismModule = typeof import('prismjs');

let prism: PrismModule | null = null;
let loading: Promise<void> | null = null;

/** Charge Prism et ses grammaires (idempotent, une seule promesse en vol). */
export function ensureHighlighter(): Promise<void> {
  if (prism) {
    return Promise.resolve();
  }
  loading ??= import('@app/services/files/prism-grammars').then((module) => {
    prism = module.default;
    loading = null;
  });
  return loading;
}

/**
 * HTML colorisé (spans `token …`, contenu échappé par Prism), ou `null` si la
 * grammaire manque ou si Prism n'est pas encore chargé. Un espace est ajouté
 * après un saut de ligne final pour que le rendu garde la même hauteur que le
 * textarea superposé.
 */
export function highlightCode(code: string, language: string): string | null {
  const grammar = prism?.languages[language];
  if (!prism || !grammar) {
    return null;
  }
  const html = prism.highlight(code, grammar, language);
  return code.endsWith('\n') ? `${html} ` : html;
}
