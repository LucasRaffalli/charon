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
  /** Un accent secret n'est jamais listé : il ne s'obtient qu'en tapant son nom. */
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
  { value: 'charon', label: 'Charon', swatch: '#5b7fa6' },
  { value: 'unloved', label: 'Unloved', swatch: '#d81e4a' },
  { value: 'jade', label: 'Jade', swatch: '#2f9e6e' },
  { value: 'unicorn', label: 'Unicorn', swatch: '#e0559f', secret: true },
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

  constructor() {
    this.restore();

    effect(() => {
      const theme = this._theme();
      this.document.documentElement.dataset['theme'] = theme;
      localStorage.setItem(THEME_KEY, theme);
    });

    effect(() => {
      const accent = this._accent();
      this.document.documentElement.dataset['accent'] = accent;
      localStorage.setItem(ACCENT_KEY, accent);
    });
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
