import { Marked } from 'marked';

import { highlightCode, languageFor } from '@app/services/code-highlight';

/** Au-delà, le rendu markdown est refusé (coût de parsing sur un gros fichier). */
const MARKDOWN_MAX = 300_000;

/**
 * Instance dédiée (pas le singleton global de marked) pour que le renderer
 * personnalisé ne fuite pas ailleurs. GFM activé : tableaux, cases à cocher,
 * barré. `breaks` reste à false, conformément au markdown de GitHub.
 */
const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    /**
     * Case à cocher GFM. Le sanitizer d'Angular retire les éléments « actifs »,
     * `<input>` compris : la case est donc redessinée en `<span>` stylé, ce qui
     * la rend de toute façon non cliquable (l'édition se fait dans la source).
     */
    checkbox({ checked }): string {
      return `<span class="md-task${checked ? ' md-task--done' : ''}"></span>`;
    },

    /**
     * Bloc clôturé : colorisé par Prism quand la langue est connue, sinon
     * simplement échappé. Le langage annoncé (```ts) est résolu par le même
     * chemin que les fichiers, en le faisant passer pour un nom de fichier.
     */
    code({ text, lang }): string {
      const id = lang ? languageFor(`x.${lang.trim().split(/\s+/)[0]}`) : null;
      const html = id ? highlightCode(text, id) : null;
      if (html) {
        return `<pre class="md-code"><code>${html}</code></pre>`;
      }
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<pre class="md-code"><code>${escaped}</code></pre>`;
    },
  },
});

/**
 * Markdown vers HTML. Le résultat traverse le sanitizer d'Angular via
 * `[innerHTML]` : le HTML brut hostile éventuellement présent dans le fichier
 * distant (script, gestionnaires inline) y est retiré.
 */
export function renderMarkdown(text: string): string {
  if (text.length > MARKDOWN_MAX) {
    return '';
  }
  return marked.parse(text, { async: false });
}
