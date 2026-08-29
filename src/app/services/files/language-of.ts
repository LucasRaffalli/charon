/**
 * Nom de grammaire pour un nom de fichier, SANS Prism.
 *
 * Ce module est pur et statique : l'icône de fichier en a besoin dans les
 * listings, et passer par le registre de Prism pour choisir une icône
 * embarquait 100 Ko de grammaires dans le bundle initial. La résolution
 * d'alias que Prism faisait tout seul (`py` → python, `yml` → yaml…) est
 * reprise ici en table, figée sur les 24 grammaires embarquées par
 * `prism-grammars.ts` : une extension inconnue rend `null`, comme avant.
 */

/** Extension (sans le point) → nom canonique de grammaire. */
const EXT_LANGUAGE: Record<string, string> = {
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  webmanifest: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  ruby: 'ruby',
  sql: 'sql',
  php: 'php',
  scss: 'scss',
  md: 'markdown',
  markdown: 'markdown',
  docker: 'docker',
  dockerfile: 'docker',
  nginx: 'nginx',
  makefile: 'makefile',
  mk: 'makefile',
  diff: 'diff',
  patch: 'diff',
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

/** Grammaire pour un nom de fichier, ou `null` si aucune ne convient. */
export function languageFor(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const byName = NAME_LANGUAGE[lower];
  if (byName) {
    return byName;
  }
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) {
    return null;
  }
  return EXT_LANGUAGE[lower.slice(dot + 1)] ?? null;
}
