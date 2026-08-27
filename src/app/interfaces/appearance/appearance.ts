// Les réglages d'apparence pilotés par le mode design. Le thème et l'accent,
// eux, vivent dans le ThemeService : ils préexistaient au mode design et
// servent ailleurs (accent secret, migration).

export const GRADIENTS = ['none', 'halo', 'aube', 'aurore', 'maille', 'voute'] as const;
export type Gradient = (typeof GRADIENTS)[number];

/**
 * L'intensité du dégradé, en pourcentage. C'est directement l'opacité du
 * calque : ce que le curseur affiche est ce qui est appliqué, sans courbe
 * cachée. 0 = invisible, 100 = à fond.
 */
export const INTENSITY_MIN = 0;
export const INTENSITY_MAX = 100;
export const INTENSITY_DEFAULT = 35;

/** Anciennes valeurs nommées, converties à la relecture. */
const LEGACY_INTENSITY: Record<string, number> = { doux: 35, marque: 72 };

export const PANEL_MODES = ['opaque', 'translucide'] as const;
export type PanelMode = (typeof PANEL_MODES)[number];

export const RADIUS_SCALES = ['net', 'doux', 'rond'] as const;
export type RadiusScale = (typeof RADIUS_SCALES)[number];

export const TEXT_SCALES = ['petit', 'normal', 'grand'] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

/** Les deux couleurs libres d'un dégradé. */
export interface GradientColors {
  from: string;
  to: string;
}

export interface Appearance {
  gradient: Gradient;
  /** Pourcentage de 0 à 100, appliqué tel quel en opacité du calque. */
  intensity: number;
  /** `null` = le dégradé suit la teinte de l'accent courant. */
  colors: GradientColors | null;
  panels: PanelMode;
  radius: RadiusScale;
  text: TextScale;
  /** Logo Charon en filigrane de fond quand on est connecté. */
  watermark: boolean;
}

/** Défauts volontairement sobres : une app propre, tout le reste se découvre. */
export const DEFAULT_APPEARANCE: Appearance = {
  gradient: 'none',
  intensity: INTENSITY_DEFAULT,
  colors: null,
  panels: 'opaque',
  radius: 'doux',
  text: 'normal',
  watermark: false,
};

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;

/** Relit l'intensité : nombre borné, ou conversion d'une ancienne valeur nommée. */
function parseIntensity(raw: unknown): number {
  if (typeof raw === 'string' && raw in LEGACY_INTENSITY) {
    return LEGACY_INTENSITY[raw];
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return INTENSITY_DEFAULT;
  }
  return Math.max(INTENSITY_MIN, Math.min(INTENSITY_MAX, Math.round(raw)));
}

const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** Relit un objet stocké en ne gardant que ce qui est valide. */
export function parseAppearance(raw: unknown): Appearance {
  const value = (raw ?? {}) as Partial<Appearance>;
  const colors = value.colors;
  return {
    gradient: oneOf(GRADIENTS, value.gradient, DEFAULT_APPEARANCE.gradient),
    intensity: parseIntensity(value.intensity),
    colors:
      colors && isHex(colors.from) && isHex(colors.to)
        ? { from: colors.from, to: colors.to }
        : null,
    panels: oneOf(PANEL_MODES, value.panels, DEFAULT_APPEARANCE.panels),
    radius: oneOf(RADIUS_SCALES, value.radius, DEFAULT_APPEARANCE.radius),
    text: oneOf(TEXT_SCALES, value.text, DEFAULT_APPEARANCE.text),
    watermark: typeof value.watermark === 'boolean' ? value.watermark : DEFAULT_APPEARANCE.watermark,
  };
}
