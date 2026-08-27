import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

import { Appearance, DEFAULT_APPEARANCE, parseAppearance } from '@app/interfaces';
import { ACCENT_OPTIONS, ThemeService } from '@app/services/appearance/theme.service';

const STORAGE_KEY = 'charon:appearance';

/** Ancien emplacement du filigrane, avant qu'il rejoigne l'apparence. */
const LEGACY_SETTINGS_KEY = 'charon:settings';

/**
 * Alphas fixes des deux couleurs du dégradé. L'intensité de l'effet est
 * pilotée séparément par l'opacité du calque (`--grad`), pas par ces valeurs :
 * « quelle couleur » et « combien » ne se mélangent pas.
 */
const GLOW_ALPHA = 0.62;
const GLOW2_ALPHA = 0.45;

const rgba = (hex: string, alpha: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

/**
 * Les réglages d'apparence du mode design : dégradé de fond, translucidité des
 * bento, rayon, taille du texte, filigrane. Posés en `data-*` sur la racine,
 * lus par `styles/_design.scss`.
 */
@Injectable({ providedIn: 'root' })
export class AppearanceService {
  private readonly document = inject(DOCUMENT);
  private readonly theme = inject(ThemeService);

  private readonly _appearance = signal<Appearance>(this.load());
  private readonly persisting = signal(true);

  readonly appearance = this._appearance.asReadonly();

  readonly gradient = computed(() => this._appearance().gradient);
  readonly intensity = computed(() => this._appearance().intensity);
  readonly colors = computed(() => this._appearance().colors);
  readonly panels = computed(() => this._appearance().panels);
  readonly radius = computed(() => this._appearance().radius);
  readonly text = computed(() => this._appearance().text);
  readonly watermark = computed(() => this._appearance().watermark);

  /** Les deux teintes effectives : celles choisies, ou celles de l'accent. */
  readonly effectiveColors = computed(() => {
    const chosen = this._appearance().colors;
    if (chosen) {
      return chosen;
    }
    const accent = this.theme.accent();
    return (
      ACCENT_OPTIONS.find((option) => option.value === accent)?.glow ?? ACCENT_OPTIONS[0].glow
    );
  });

  constructor() {
    effect(() => {
      const value = this._appearance();
      const root = this.document.documentElement;
      root.dataset['gradient'] = value.gradient;
      root.dataset['panels'] = value.panels;
      // L'opacité du calque est posée ici plutôt qu'en CSS : sans motif, pas
      // de calque, quelle que soit l'intensité.
      root.style.setProperty(
        '--grad',
        value.gradient === 'none' ? '0' : String(value.intensity / 100),
      );
      root.dataset['radius'] = value.radius;
      root.dataset['text'] = value.text;

      if (this.persisting()) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      }
    });

    // Les couleurs du dégradé, qu'elles soient libres ou héritées de l'accent.
    effect(() => {
      const { from, to } = this.effectiveColors();
      const root = this.document.documentElement;
      root.style.setProperty('--glow', rgba(from, GLOW_ALPHA));
      root.style.setProperty('--glow2', rgba(to, GLOW2_ALPHA));
    });
  }

  update(patch: Partial<Appearance>): void {
    this._appearance.update((current) => ({ ...current, ...patch }));
  }

  set(value: Appearance): void {
    this._appearance.set(value);
  }

  setPersisting(on: boolean): void {
    this.persisting.set(on);
  }

  private load(): Appearance {
    let stored: unknown = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      stored = null;
    }

    const appearance = parseAppearance(stored);

    // Le filigrane vivait dans les réglages avant d'être une affaire de design.
    if (!stored) {
      try {
        const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
        const parsed = legacy ? (JSON.parse(legacy) as { logoBackground?: unknown }) : null;
        if (typeof parsed?.logoBackground === 'boolean') {
          return { ...appearance, watermark: parsed.logoBackground };
        }
      } catch {
        return appearance;
      }
    }

    return appearance;
  }
}

export { DEFAULT_APPEARANCE };
