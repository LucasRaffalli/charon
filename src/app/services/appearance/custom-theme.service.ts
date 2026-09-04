import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

const STORAGE_KEY = 'charon:custom-theme';
const UNLOCK_KEY = 'charon:atelier';

/**
 * Un jeton modifiable de l'atelier : sa variable CSS, son libellé, et le
 * groupe où il s'affiche.
 */
export interface ThemeToken {
  /** Nom de la variable, sans les tirets de tête. */
  name: string;
  label: string;
  group: 'surfaces' | 'traits' | 'texte' | 'accent' | 'statuts';
}

/**
 * Les jetons ouverts à l'édition.
 *
 * Une sélection, pas la liste complète. Un thème de Charon définit une
 * quarantaine de variables, dont seize pour le seul terminal : les exposer
 * toutes ferait un tableur, pas un atelier. Celles-ci sont les quinze qui
 * DÉFINISSENT une identité visuelle ; tout le reste (alias d'élévation,
 * fonds de statut, anneau de focus, palettes de code et de terminal) en
 * découle ou reste au thème de base.
 */
export const THEME_TOKENS: readonly ThemeToken[] = [
  { name: 'elev-0', label: "Fond de l'application", group: 'surfaces' },
  { name: 'elev-1', label: 'Panneaux et barres', group: 'surfaces' },
  { name: 'elev-2', label: 'En-têtes et champs', group: 'surfaces' },
  { name: 'elev-3', label: 'Surfaces flottantes', group: 'surfaces' },
  { name: 'border', label: 'Filet', group: 'traits' },
  { name: 'border-strong', label: 'Filet appuyé', group: 'traits' },
  { name: 'text', label: 'Texte', group: 'texte' },
  { name: 'text-muted', label: 'Texte secondaire', group: 'texte' },
  { name: 'text-faint', label: 'Texte discret', group: 'texte' },
  { name: 'accent', label: 'Accent', group: 'accent' },
  { name: 'accent-solid', label: 'Accent en aplat', group: 'accent' },
  { name: 'success', label: 'Succès', group: 'statuts' },
  { name: 'warning', label: 'Avertissement', group: 'statuts' },
  { name: 'danger', label: 'Danger', group: 'statuts' },
  { name: 'pending', label: 'En attente', group: 'statuts' },
];

/** Les groupes, dans l'ordre où l'atelier les présente. */
export const TOKEN_GROUPS: readonly { id: ThemeToken['group']; label: string }[] = [
  { id: 'surfaces', label: 'Surfaces' },
  { id: 'traits', label: 'Traits' },
  { id: 'texte', label: 'Texte' },
  { id: 'accent', label: 'Accent' },
  { id: 'statuts', label: 'Statuts' },
];

/**
 * Les statuts et l'accent traînent des variables dérivées (le fond teinté
 * d'un toast, l'anneau de focus). Les recalculer évite qu'un danger passé au
 * violet garde un fond rougeâtre : on dériverait sinon une incohérence à
 * chaque jeton touché.
 */
const DERIVED: Record<string, (value: string) => Record<string, string>> = {
  success: (v) => ({ 'success-bg': tint(v) }),
  warning: (v) => ({ 'warning-bg': tint(v) }),
  danger: (v) => ({ 'danger-bg': tint(v), 'danger-solid': v }),
  pending: (v) => ({ 'pending-bg': tint(v) }),
  accent: (v) => ({ 'focus-ring': v }),
};

const tint = (color: string): string => `color-mix(in srgb, ${color} 13%, transparent)`;

const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export interface CustomTheme {
  /**
   * Les jetons modifiés, par nom de variable (sans les tirets).
   *
   * Pas de thème « de base » retenu ici : le calque se pose sur le thème
   * COURANT, celui que la carte Design gouverne déjà. Le dupliquer dans
   * l'atelier ferait deux sélecteurs pour une seule chose.
   */
  tokens: Record<string, string>;
}

/**
 * L'atelier : fabriquer son propre thème (code caché, voir
 * `SecretAccentService`).
 *
 * Un thème sur mesure n'est PAS une palette repartie de zéro mais un
 * **calque** posé sur un thème existant : on choisit une base (clair, sombre,
 * contraste) et on ne redéfinit que ce qu'on veut. Tout le reste continue de
 * marcher — les palettes de coloration et de terminal, les voiles d'état, les
 * alias d'élévation — au lieu de laisser des trous partout où l'atelier
 * n'aurait pas pensé.
 *
 * Les jetons sont posés en style INLINE sur la racine : ils gagnent sur
 * n'importe quel sélecteur de thème ou d'accent, sans qu'on ait à jouer à la
 * spécificité.
 */
@Injectable({ providedIn: 'root' })
export class CustomThemeService {
  private readonly document = inject(DOCUMENT);

  /** L'atelier a-t-il été trouvé ? Une fois ouvert, il le reste. */
  private readonly _unlocked = signal(readUnlocked());
  readonly unlocked = this._unlocked.asReadonly();

  private readonly _custom = signal<CustomTheme | null>(load());
  readonly custom = this._custom.asReadonly();

  /** Le thème sur mesure est-il en service ? */
  readonly active = computed(() => this._custom() !== null);

  private readonly persisting = signal(true);

  constructor() {
    effect(() => {
      const custom = this._custom();
      const root = this.document.documentElement;
      // Toujours repartir d'une racine propre : un jeton retiré de la liste
      // doit disparaître de l'écran, pas y rester par oubli.
      for (const token of THEME_TOKENS) {
        root.style.removeProperty(`--${token.name}`);
        for (const derived of Object.keys(DERIVED[token.name]?.('#000') ?? {})) {
          root.style.removeProperty(`--${derived}`);
        }
      }
      if (custom) {
        for (const [name, value] of Object.entries(custom.tokens)) {
          root.style.setProperty(`--${name}`, value);
          for (const [derived, computed] of Object.entries(DERIVED[name]?.(value) ?? {})) {
            root.style.setProperty(`--${derived}`, computed);
          }
        }
      }
      if (this.persisting()) {
        if (custom) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    });
  }

  /** Seule porte d'entrée : le code tapé dans l'application. */
  unlock(): void {
    if (this._unlocked()) {
      return;
    }
    this._unlocked.set(true);
    try {
      localStorage.setItem(UNLOCK_KEY, '1');
    } catch {
      // Le stockage indisponible ne referme pas l'atelier de la session.
    }
  }

  /**
   * Démarre un thème sur mesure à partir de ce qui est à l'écran.
   *
   * On lit les valeurs CALCULÉES plutôt que de partir de blancs : l'atelier
   * s'ouvre sur le thème qu'on avait, et modifier une couleur est un geste,
   * pas la reconstruction de quinze champs.
   */
  begin(): void {
    if (this._custom()) {
      return;
    }
    const styles = getComputedStyle(this.document.documentElement);
    const tokens: Record<string, string> = {};
    for (const token of THEME_TOKENS) {
      tokens[token.name] = normalize(styles.getPropertyValue(`--${token.name}`).trim());
    }
    this._custom.set({ tokens });
  }

  setToken(name: string, value: string): void {
    if (!THEME_TOKENS.some((token) => token.name === name) || !isHexColor(value)) {
      return;
    }
    this._custom.update((current) => (current ? { ...current, tokens: { ...current.tokens, [name]: value } } : current));
  }

  /** Retour au thème d'origine : le calque est retiré, rien n'est perdu du thème de base. */
  reset(): void {
    this._custom.set(null);
  }

  set(value: CustomTheme | null): void {
    this._custom.set(value);
  }

  setPersisting(on: boolean): void {
    this.persisting.set(on);
  }

  /** Une autre fenêtre a modifié le thème sur mesure : on relit. */
  reloadFromStorage(): void {
    const stored = load();
    if (JSON.stringify(stored) !== JSON.stringify(this._custom())) {
      this._custom.set(stored);
    }
  }
}

/** Les couleurs calculées reviennent souvent en `rgb(...)` : un champ de
 *  couleur natif n'accepte que la notation hexadécimale. */
function normalize(value: string): string {
  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (!rgb) {
    return value.startsWith('#') ? value : '#000000';
  }
  const parts = rgb[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3);
  const hex = parts.map((part) => {
    const n = Math.max(0, Math.min(255, Math.round(Number.parseFloat(part))));
    return n.toString(16).padStart(2, '0');
  });
  return hex.length === 3 ? `#${hex.join('')}` : '#000000';
}

function load(): CustomTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<CustomTheme>;
    if (typeof parsed.tokens !== 'object' || !parsed.tokens) {
      return null;
    }
    // Ne reprend que les jetons connus : un thème enregistré par une version
    // future ne doit pas poser des variables que celle-ci ignore.
    const tokens: Record<string, string> = {};
    for (const token of THEME_TOKENS) {
      const value = (parsed.tokens as Record<string, unknown>)[token.name];
      if (isHexColor(value)) {
        tokens[token.name] = value;
      }
    }
    return { tokens };
  } catch {
    return null;
  }
}

function readUnlocked(): boolean {
  try {
    return localStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}
