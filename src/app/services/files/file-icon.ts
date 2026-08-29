import type { IconName } from '@app/components/ui/icon/icon';
import { languageFor } from '@app/services/files/language-of';

/**
 * Icône par grammaire Prism. Volontairement grossier : quelques familles
 * lucide monochromes plutôt que des logos par langage, pour rester dans le
 * ton du reste de l'interface. Les grammaires absentes retombent sur
 * `file-code`, puisque `languageFor` n'a répondu que pour du texte structuré.
 */
const LANGUAGE_ICON: Record<string, IconName> = {
  json: 'file-json',
  yaml: 'file-config',
  toml: 'file-config',
  ini: 'file-config',
  docker: 'file-config',
  nginx: 'file-config',
  makefile: 'file-config',
  bash: 'file-shell',
  markdown: 'file-text',
  diff: 'file-diff',
};

/** Extensions d'images : reconnues avant tout essai de grammaire. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

/** Icône à afficher pour un fichier, d'après son nom. */
export function fileIconFor(fileName: string): IconName {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) {
    return 'file-image';
  }
  const language = languageFor(fileName);
  if (!language) {
    return 'file';
  }
  return LANGUAGE_ICON[language] ?? 'file-code';
}
