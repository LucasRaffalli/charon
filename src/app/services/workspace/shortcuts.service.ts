import { Injectable, signal } from '@angular/core';

/**
 * Un raccourci déclaré par un écran ou un panneau.
 *
 * `keys` s'écrit en minuscules, modificateurs d'abord, séparés par `+` :
 * `mod+d`, `mod+shift+n`, `f2`, `space`, `arrowup`. **`mod` vaut Cmd sur macOS
 * et Ctrl ailleurs** : les deux plateformes partagent une seule déclaration,
 * il n'y a pas de table par système.
 */
export interface Shortcut {
  keys: string;
  /** Ce que le raccourci fait, tel qu'il s'affiche dans la liste. */
  label: string;
  /** Rubrique de la liste (⌘/) : « Sélection », « Naviguer »… */
  group: string;
  run: () => void;
  /** Faux = le raccourci existe mais ne s'applique pas maintenant. */
  when?: () => boolean;
  /**
   * Tire aussi quand le focus est dans un champ de saisie ou le terminal.
   * Réservé à ce qui ne peut pas être confondu avec de la frappe.
   */
  evenWhileTyping?: boolean;
}

/** L'ordre des rubriques dans la liste, pour qu'elle se lise comme un tout. */
const GROUP_ORDER = [
  'Sélection',
  'Naviguer',
  'Fichiers',
  'Transférer',
  'Panneaux',
  'Application',
];

/**
 * Le registre des raccourcis clavier.
 *
 * Central, et non éparpillé en écouteurs : c'est la seule façon d'avoir une
 * liste complète à montrer (⌘/), de repérer deux raccourcis qui se marchent
 * dessus, et de faire une règle unique sur ce qui tire pendant qu'on tape.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutsService {
  private readonly registry = signal<readonly Shortcut[]>([]);

  /** La liste (⌘/) est ouverte. */
  readonly listOpen = signal(false);

  /**
   * Déclare des raccourcis, et rend de quoi les retirer : un panneau qui
   * disparaît ne doit pas laisser ses touches derrière lui.
   */
  register(shortcuts: readonly Shortcut[]): () => void {
    this.registry.update((list) => [...list, ...shortcuts]);
    return () => {
      this.registry.update((list) => list.filter((s) => !shortcuts.includes(s)));
    };
  }

  /** Les raccourcis applicables, groupés et ordonnés, pour la liste. */
  grouped(): { group: string; items: Shortcut[] }[] {
    const byGroup = new Map<string, Shortcut[]>();
    for (const shortcut of this.registry()) {
      const list = byGroup.get(shortcut.group) ?? [];
      list.push(shortcut);
      byGroup.set(shortcut.group, list);
    }
    return [...byGroup]
      .sort((a, b) => {
        const ia = GROUP_ORDER.indexOf(a[0]);
        const ib = GROUP_ORDER.indexOf(b[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
      .map(([group, items]) => ({ group, items }));
  }

  /**
   * Confronte une frappe au registre. Rend vrai si un raccourci a tiré, pour
   * que l'appelant sache s'il doit laisser passer l'événement.
   */
  handle(event: KeyboardEvent): boolean {
    const typing = isTyping(event.target);
    const pressed = describe(event);
    if (!pressed.length) {
      return false;
    }
    for (const shortcut of this.registry()) {
      if (!pressed.includes(shortcut.keys)) {
        continue;
      }
      if (typing && !shortcut.evenWhileTyping) {
        continue;
      }
      if (shortcut.when && !shortcut.when()) {
        continue;
      }
      event.preventDefault();
      shortcut.run();
      return true;
    }
    return false;
  }
}

/**
 * Les façons d'écrire la frappe, de la plus précise à la plus tolérante.
 *
 * `metaKey` et `ctrlKey` deviennent tous deux `mod` : sur macOS c'est Cmd,
 * ailleurs Ctrl, et une déclaration unique couvre les deux.
 *
 * Plusieurs candidats, parce que **Shift fait parfois partie du caractère**.
 * Sur un clavier français, `/` s'obtient avec Shift : la frappe se décrit
 * alors `mod+shift+/` alors que le raccourci est déclaré `mod+/`, et ⌘/ ne
 * marchait pas. Pour une touche de ponctuation, la variante sans `shift` est
 * donc proposée aussi — une lettre, elle, garde sa distinction (⌘S et ⌘⇧S ne
 * sont pas le même geste sur aucune disposition).
 */
function describe(event: KeyboardEvent): string[] {
  const key = event.key.toLowerCase();
  // Une touche de modificateur seule n'est pas une frappe.
  if (['meta', 'control', 'shift', 'alt'].includes(key)) {
    return [];
  }
  const base: string[] = [];
  if (event.metaKey || event.ctrlKey) {
    base.push('mod');
  }
  if (event.altKey) {
    base.push('alt');
  }
  const name = key === ' ' ? 'space' : key;
  const exact = [...base, ...(event.shiftKey ? ['shift'] : []), name].join('+');

  // Un seul caractère et pas alphanumérique : Shift a pu servir à le produire.
  const punctuation = name.length === 1 && !/[a-z0-9]/.test(name);
  if (event.shiftKey && punctuation) {
    return [exact, [...base, name].join('+')];
  }
  return [exact];
}

/**
 * Le focus est-il dans quelque chose qui reçoit de la frappe ?
 *
 * Le terminal en fait partie : xterm rend un textarea caché, et un raccourci
 * qui tirerait pendant qu'on y tape volerait la touche au shell.
 */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.closest) {
    return false;
  }
  return !!element.closest('input, textarea, select, [contenteditable="true"], .xterm');
}

/** Le raccourci en symboles, pour l'affichage (⌘⇧N). */
export function shortcutSymbols(keys: string, mac: boolean): string[] {
  return keys.split('+').map((part) => {
    switch (part) {
      case 'mod':
        return mac ? '⌘' : 'Ctrl';
      case 'shift':
        return '⇧';
      case 'alt':
        return mac ? '⌥' : 'Alt';
      case 'space':
        return 'Espace';
      case 'arrowup':
        return '↑';
      case 'arrowdown':
        return '↓';
      case 'enter':
        return '↵';
      case 'backspace':
        return '⌫';
      case 'escape':
        return 'Échap';
      default:
        return part.length === 1 ? part.toUpperCase() : part;
    }
  });
}
