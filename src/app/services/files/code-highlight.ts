import Prism from 'prismjs';

// Grammaires embarquées (l'ordre compte : c avant cpp, markup-templating
// avant php, typescript/jsx avant tsx). Chaque grammaire enregistre aussi ses
// propres alias (`py`, `ts`, `yml`, `md`…), ce dont `languageFor` se sert pour
// éviter de retaper la liste des extensions.
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-diff';

// Pas de scan automatique du DOM au chargement.
Prism.manual = true;

/**
 * Clés de `Prism.languages` qui ne sont PAS des grammaires colorables :
 * les helpers du coeur et les grammaires vides « texte brut ». Sans ce filtre,
 * un `.txt` passerait par la couche de coloration pour n'y rien colorier.
 */
const NOT_A_GRAMMAR = new Set([
  'extend',
  'insertBefore',
  'DFS',
  'plain',
  'plaintext',
  'text',
  'txt',
  'none',
]);

/**
 * Extensions que Prism ne résout pas via ses propres alias. Tout le reste
 * (`py`, `ts`, `rb`, `yml`, `sh`, `md`, `sql`, `php`, `scss`, `c`, `cpp`…)
 * est trouvé directement dans `Prism.languages`, d'où la brièveté de la table.
 */
const EXT_ALIAS: Record<string, string> = {
  rs: 'rust',
  htm: 'markup',
  vue: 'markup',
  svelte: 'markup',
  h: 'c',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  webmanifest: 'json',
  mk: 'makefile',
  patch: 'diff',
  zsh: 'bash',
};

/** Fichiers sans extension parlante, reconnus par leur nom complet. */
const NAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.env': 'ini',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.zshrc': 'bash',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.zprofile': 'bash',
  '.profile': 'bash',
};

/**
 * Grammaires importées ci-dessus, sous leur nom canonique (plus celles que le
 * coeur embarque). Sert à ramener un alias à son nom de référence : `md` et
 * `markdown` désignent le MÊME objet grammaire, donc une comparaison
 * d'identité suffit, sans avoir à lister les alias un par un.
 */
const LOADED = [
  'markup',
  'css',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'json',
  'yaml',
  'toml',
  'ini',
  'bash',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'ruby',
  'sql',
  'php',
  'scss',
  'markdown',
  'docker',
  'nginx',
  'makefile',
  'diff',
];

/** Renvoie le nom canonique de la grammaire `id`, ou `null` si elle n'existe pas. */
function grammarId(id: string): string | null {
  if (NOT_A_GRAMMAR.has(id)) {
    return null;
  }
  const grammar: unknown = Prism.languages[id];
  if (!grammar || typeof grammar !== 'object') {
    return null;
  }
  return LOADED.find((name) => Prism.languages[name] === grammar) ?? id;
}

/** Grammaire Prism pour un nom de fichier, ou `null` si aucune ne convient. */
export function languageFor(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const byName = NAME_LANGUAGE[lower];
  if (byName) {
    return grammarId(byName);
  }
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  const ext = lower.slice(dot + 1);
  return grammarId(EXT_ALIAS[ext] ?? ext);
}

/**
 * HTML colorisé (spans `token …`, contenu échappé par Prism), ou `null` si la
 * grammaire manque. Un espace est ajouté après un saut de ligne final pour que
 * le rendu garde la même hauteur que le textarea superposé.
 */
export function highlightCode(code: string, language: string): string | null {
  const grammar = Prism.languages[language];
  if (!grammar) {
    return null;
  }
  const html = Prism.highlight(code, grammar, language);
  return code.endsWith('\n') ? `${html} ` : html;
}
