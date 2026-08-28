import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

import { IconName } from '@app/components/ui/icon/icon';
import { Accent, Theme, isAccent, isTheme } from '@app/interfaces';

const THEME_KEY = 'charon:theme';
const ACCENT_KEY = 'charon:accent';

export interface ThemeOption {
  value: Theme;
  icon: IconName;
  label: string;
}

export interface AccentOption {
  value: Accent;
  label: string;
  /** Couleur montrée dans la pastille du sélecteur (le fond plein). */
  swatch: string;
  /** Les deux teintes que reprend le dégradé quand il suit l'accent. */
  glow: { from: string; to: string };
  /** Un accent secret n'est jamais listé : voir SecretAccentService pour l'ouvrir. */
  secret?: boolean;
}

/** Liste unique des thèmes proposés (grille du panneau de réglages). */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'light', icon: 'sun', label: 'Clair' },
  { value: 'dark', icon: 'moon', label: 'Sombre' },
  { value: 'contrast', icon: 'contrast', label: 'Contraste' },
];

/** Liste unique des accents. Le secret est filtré tant qu'il dort. */
export const ACCENT_OPTIONS: readonly AccentOption[] = [
  { value: 'charon', label: 'Charon', swatch: '#5b7fa6', glow: { from: '#5b7fa6', to: '#7da3cc' } },
  { value: 'unloved', label: 'Unloved', swatch: '#d81e4a', glow: { from: '#d81e4a', to: '#ff7f9d' } },
  { value: 'jade', label: 'Jade', swatch: '#2f9e6e', glow: { from: '#2f9e6e', to: '#5fc79b' } },
  {
    value: 'unicorn',
    label: 'Unicorn',
    swatch: '#e0559f',
    glow: { from: '#e0559f', to: '#c19bff' },
    secret: true,
  },
];

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly _theme = signal<Theme>('dark');
  private readonly _accent = signal<Accent>('charon');

  readonly theme = this._theme.asReadonly();
  readonly accent = this._accent.asReadonly();

  /**
   * Les accents proposés dans les réglages. Un accent secret n'y entre que
   * s'il est déjà actif : on voit ce qui est sélectionné et on peut en sortir,
   * sans jamais révéler son existence à qui ne l'a pas trouvé.
   */
  readonly visibleAccents = computed(() => {
    const current = this._accent();
    return ACCENT_OPTIONS.filter((option) => !option.secret || option.value === current);
  });

  /**
   * Le mode design applique tout de suite pour qu'on voie, mais n'enregistre
   * rien tant qu'on n'a pas confirmé. Tant que c'est faux, l'effet pose bien
   * l'attribut mais n'écrit pas dans le stockage ; au retour à vrai, il écrit
   * ce qui est alors courant, donc l'état retenu après un abandon.
   */
  private readonly persisting = signal(true);

  constructor() {
    this.restore();

    effect(() => {
      const theme = this._theme();
      this.document.documentElement.dataset['theme'] = theme;
      if (this.persisting()) {
        localStorage.setItem(THEME_KEY, theme);
      }
    });

    effect(() => {
      const accent = this._accent();
      this.document.documentElement.dataset['accent'] = accent;
      if (this.persisting()) {
        localStorage.setItem(ACCENT_KEY, accent);
      }
    });
  }

  setPersisting(on: boolean): void {
    this.persisting.set(on);
  }

  select(theme: Theme): void {
    this._theme.set(theme);
  }

  /** Depuis l'interface : les accents secrets ne peuvent pas être choisis. */
  selectAccent(accent: Accent): void {
    if (ACCENT_OPTIONS.find((option) => option.value === accent)?.secret) {
      return;
    }
    this._accent.set(accent);
  }

  /** Seule porte d'entrée de l'accent caché : le code tapé dans l'app. */
  activateSecretAccent(): void {
    this._accent.set('unicorn');
  }

  /**
   * Repose un accent sans passer par le filtre du secret. Réservé au retour en
   * arrière du mode design : abandonner doit rendre l'état d'avant, y compris
   * quand cet état était l'accent caché.
   */
  restoreAccent(accent: Accent): void {
    this._accent.set(accent);
  }

  private restore(): void {
    const storedTheme = localStorage.getItem(THEME_KEY);
    const storedAccent = localStorage.getItem(ACCENT_KEY);

    // Unicorn était un thème avant d'être un accent : on convertit sans rien
    // perdre, plutôt que de renvoyer l'utilisateur au sombre par défaut.
    if (storedTheme === 'unicorn') {
      this._theme.set('dark');
      this._accent.set('unicorn');
      return;
    }

    if (isTheme(storedTheme)) {
      this._theme.set(storedTheme);
    } else {
      const prefersLight = this.document.defaultView?.matchMedia('(prefers-color-scheme: light)');
      this._theme.set(prefersLight?.matches ? 'light' : 'dark');
    }

    // L'accent caché se relit tel quel : une fois trouvé, il tient.
    if (isAccent(storedAccent)) {
      this._accent.set(storedAccent);
    }
  }
}
