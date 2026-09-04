import { DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  Appearance,
  DEFAULT_APPEARANCE,
  GradientSpot,
  parseAppearance,
} from '@app/interfaces';
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
  readonly spots = computed(() => this._appearance().spots);
  readonly panels = computed(() => this._appearance().panels);
  readonly radius = computed(() => this._appearance().radius);
  readonly text = computed(() => this._appearance().text);
  readonly watermark = computed(() => this._appearance().watermark);
  readonly markOpacity = computed(() => this._appearance().markOpacity);
  readonly markSize = computed(() => this._appearance().markSize);
  readonly markColor = computed(() => this._appearance().markColor);
  readonly markImage = computed(() => this._appearance().markImage);
  readonly markMode = computed(() => this._appearance().markMode);

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
      // Le motif « libre » est COMPOSÉ ici et non dans la feuille : le nombre
      // de sources est variable (de une à six) et leurs formes diffèrent, ce
      // qu'aucune règle CSS ne sait exprimer. Il est posé en inline, donc il
      // gagne sur la feuille ; retiré pour les autres motifs, sinon il
      // écraserait le leur.
      if (value.gradient === 'libre') {
        root.style.setProperty('--grad-image', composeGradient(value.spots));
      } else {
        root.style.removeProperty('--grad-image');
      }
      root.dataset['radius'] = value.radius;
      root.dataset['text'] = value.text;

      // Le filigrane : opacité, taille et teinte. En variables et non en dur
      // dans la feuille, pour que l'atelier puisse les régler.
      root.style.setProperty('--mark-opacity', String(value.markOpacity / 100));
      root.style.setProperty('--mark-scale', String(value.markSize / 100));
      if (value.markColor) {
        root.style.setProperty('--mark-color', value.markColor);
      } else {
        root.style.removeProperty('--mark-color');
      }
      // L'image du filigrane : le glyphe par défaut, celle de l'utilisateur
      // sinon. `data-mark` dit si elle se teinte (masque) ou s'affiche telle
      // quelle, la feuille fait le reste.
      if (value.markImage) {
        root.style.setProperty('--mark-image', `url("${value.markImage}")`);
      } else {
        root.style.removeProperty('--mark-image');
      }
      root.dataset['mark'] = value.markImage ? value.markMode : 'silhouette';

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
      // Les mêmes teintes en OPAQUE : les pastilles de l'ajusteur de foyers
      // portent la couleur qu'elles placent, et une couleur à 14 % d'alpha
      // ne se verrait pas sur une pastille de treize pixels.
      root.style.setProperty('--glow-solid', from);
      root.style.setProperty('--glow2-solid', to);
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

  /** Une autre fenêtre a changé le fond ou les panneaux : on relit, en ne
   *  posant que si quelque chose diffère (l'égalité coupe l'écho). */
  reloadFromStorage(): void {
    const stored = this.load();
    if (JSON.stringify(stored) !== JSON.stringify(this._appearance())) {
      this._appearance.set(stored);
    }
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

/**
 * Le motif « libre », en une valeur CSS : une couche par source de lumière,
 * dans l'ordre où elles ont été posées (la dernière passe devant).
 *
 * Chaque forme est un dégradé natif du navigateur, pas une image : c'est ce
 * qui permet d'en empiler six sans coûter plus qu'un fond ordinaire.
 */
function composeGradient(spots: readonly GradientSpot[]): string {
  return spots.map(layerOf).join(', ');
}

function layerOf(spot: GradientSpot): string {
  const color = colorOf(spot);
  const at = `at ${spot.x}% ${spot.y}%`;
  const size = spot.size;

  switch (spot.shape) {
    case 'beam':
      return beamLayer(spot, color);
    case 'edge':
      // Une lueur d'horizon : très large, très plate. C'est ce qui la
      // distingue de la tache, qui reste ronde quelle que soit sa taille.
      return `radial-gradient(${size * 2.4}% ${size * 0.5}% ${at}, ${color}, transparent 70%)`;
    case 'ring':
      return `radial-gradient(${size}% ${size}% ${at}, transparent 40%, ${color} 58%, transparent 78%)`;
    default:
      return `radial-gradient(${size}% ${size}% ${at}, ${color}, transparent 68%)`;
  }
}

/**
 * L'écharpe oblique, POSITIONNABLE.
 *
 * Un `linear-gradient` n'a pas de point d'ancrage : ses arrêts se placent le
 * long d'un axe qui traverse le centre, et la position (x, y) de la source
 * n'y veut rien dire telle quelle. C'est pour cette raison que l'écharpe
 * paraissait immobile alors qu'on la déplaçait bel et bien.
 *
 * On projette donc le point sur l'axe du dégradé pour en tirer la position
 * de l'arrêt lumineux. Repères de la formule : à 90° (vers la droite), un
 * point à x = 20 donne un arrêt à 20 % ; à 0° (vers le haut), un point tout
 * en haut donne 100 %, tout en bas 0 % ; et le centre donne 50 % quel que
 * soit l'angle.
 */
/**
 * La couleur d'une source : la sienne si elle en a une, sinon l'une des deux
 * du dégradé. Son intensité propre s'y applique dans les deux cas — mais par
 * des chemins différents, une variable CSS ne se multipliant pas.
 */
function colorOf(spot: GradientSpot): string {
  const strength = spot.alpha / 100;
  if (spot.tint) {
    // Couleur propre : on compose l'alpha directement, en repartant du même
    // barème que les couleurs partagées pour que les deux se ressemblent.
    const base = spot.color === 1 ? GLOW2_ALPHA : GLOW_ALPHA;
    return rgba(spot.tint, Math.min(1, base * strength));
  }
  const shared = spot.color === 1 ? 'var(--glow2)' : 'var(--glow)';
  // Couleur partagée : `color-mix` module son opacité sans avoir à connaître
  // sa valeur, qui vit dans une variable posée ailleurs.
  return strength === 1
    ? shared
    : `color-mix(in srgb, ${shared} ${Math.round(Math.min(100, strength * 100))}%, transparent)`;
}

function beamLayer(spot: GradientSpot, color: string): string {
  const radians = (spot.angle * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const axis = Math.abs(sin) + Math.abs(cos);
  const center = 50 + ((spot.x - 50) * sin + (50 - spot.y) * cos) / axis;

  // La largeur de la bande, de part et d'autre de l'arrêt lumineux. Bornée
  // aux extrémités, sinon un arrêt hors [0, 100] fait disparaître la bande.
  const half = spot.size / 2;
  const from = Math.max(0, Math.min(100, center - half));
  const to = Math.max(0, Math.min(100, center + half));
  return `linear-gradient(${spot.angle}deg, transparent ${from.toFixed(1)}%, ${color} ${center.toFixed(1)}%, transparent ${to.toFixed(1)}%)`;
}
