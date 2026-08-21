import { DOCUMENT, Injectable, effect, inject, signal } from '@angular/core';

import { Theme, isTheme } from '@app/interfaces';

const STORAGE_KEY = 'charon:theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly _theme = signal<Theme>(this.initialTheme());
  readonly theme = this._theme.asReadonly();

  constructor() {
    effect(() => {
      const theme = this._theme();
      this.document.documentElement.dataset['theme'] = theme;
      localStorage.setItem(STORAGE_KEY, theme);
    });
  }

  select(theme: Theme): void {
    this._theme.set(theme);
  }

  private initialTheme(): Theme {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) {
      return stored;
    }
    const prefersLight = this.document.defaultView?.matchMedia('(prefers-color-scheme: light)');
    return prefersLight?.matches ? 'light' : 'dark';
  }
}
