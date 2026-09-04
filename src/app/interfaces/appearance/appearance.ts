// Les réglages d'apparence pilotés par le mode design. Le thème et l'accent,
// eux, vivent dans le ThemeService : ils préexistaient au mode design et
// servent ailleurs (accent secret, migration).

export const GRADIENTS = [
  'none',
  'halo',
  'aube',
  'aurore',
  'maille',
  'voute',
  // « libre » : deux foyers de lumière que l'on place soi-même. Les cinq
  // autres motifs sont des compositions figées ; celui-ci est l'atelier du
  // fond, et il ne veut rien dire sans les `spots` ci-dessous.
  'libre',
] as const;
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

/**
 * La forme d'une source de lumière du dégradé libre.
 *
 * - `spot` : une tache ronde, la lumière la plus banale ;
 * - `beam` : une écharpe oblique qui traverse, l'orientation venant de
 *   l'angle (c'est le motif « Aurore », mais placé à la main) ;
 * - `edge` : une montée de lumière depuis le bord le plus proche, pour les
 *   fonds qui s'éclairent par le bas comme « Aube » ;
 * - `ring` : un anneau, lumineux sur son pourtour et creux au centre.
 */
export type SpotShape = 'spot' | 'beam' | 'edge' | 'ring';
export const SPOT_SHAPES: readonly SpotShape[] = ['spot', 'beam', 'edge', 'ring'];

/** Une source de lumière du dégradé libre : sa forme, sa place et son
 *  étendue, en pourcentages de la fenêtre. */
export interface GradientSpot {
  shape: SpotShape;
  x: number;
  y: number;
  size: number;
  /** Orientation, en degrés. N'a de sens que pour `beam`. */
  angle: number;
  /** Laquelle des deux couleurs du dégradé cette source emploie (0 ou 1).
   *  Ignoré dès que `tint` est posée. */
  color: 0 | 1;
  /**
   * Sa couleur PROPRE, indépendante des deux du dégradé ; `null` = elle suit
   * `color`. C'est ce qui permet un fond à six teintes différentes, là où
   * les deux couleurs partagées n'en donnaient que deux.
   */
  tint: string | null;
  /** Son intensité à elle, en pourcentage de l'intensité normale. */
  alpha: number;
}

/** Les deux foyers par défaut : un en haut à gauche, un en bas à droite,
 *  c'est-à-dire la composition de « Halo », point de départ familier. */
export const DEFAULT_SPOTS: readonly GradientSpot[] = [
  { shape: 'spot', x: 10, y: 0, size: 55, angle: 112, color: 0, tint: null, alpha: 100 },
  { shape: 'spot', x: 92, y: 100, size: 48, angle: 112, color: 1, tint: null, alpha: 100 },
];

/** Au-delà, le fond devient une soupe : six lumières se distinguent encore,
 *  la septième ne fait plus que remplir. */
export const MAX_SPOTS = 6;

export interface Appearance {
  gradient: Gradient;
  /** Pourcentage de 0 à 100, appliqué tel quel en opacité du calque. */
  intensity: number;
  /** `null` = le dégradé suit la teinte de l'accent courant. */
  colors: GradientColors | null;
  /** Les foyers du motif « libre » ; ignorés par les autres motifs. */
  spots: GradientSpot[];
  panels: PanelMode;
  radius: RadiusScale;
  text: TextScale;
  /** Logo Charon en filigrane de fond quand on est connecté. */
  watermark: boolean;
  /** Opacité du filigrane, en pourcentage (l'atelier seul y touche). */
  markOpacity: number;
  /** Taille du filigrane, en pourcentage de sa taille de référence. */
  markSize: number;
  /** Teinte du filigrane ; `null` = la couleur du texte, comme avant. */
  markColor: string | null;
  /**
   * L'image du filigrane, en data-URI ; `null` = le glyphe de Charon.
   *
   * En data-URI et non en chemin : le fichier choisi vit chez l'utilisateur,
   * un chemin cesserait de marcher au premier déplacement, et la CSP
   * n'autorise de toute façon que `'self'` et `data:` pour les images.
   * Redimensionnée à l'import (voir `readWatermark`) : le stockage local se
   * compte en méga-octets, pas en photos d'appareil.
   */
  markImage: string | null;
  /**
   * `silhouette` : l'image sert de masque, teintée comme le glyphe.
   * `image` : elle s'affiche telle quelle, couleurs comprises.
   */
  markMode: MarkMode;
}

export type MarkMode = 'silhouette' | 'image';
export const MARK_MODES: readonly MarkMode[] = ['silhouette', 'image'];

/** Défauts volontairement sobres : une app propre, tout le reste se découvre. */
export const DEFAULT_APPEARANCE: Appearance = {
  gradient: 'none',
  intensity: INTENSITY_DEFAULT,
  colors: null,
  spots: DEFAULT_SPOTS.map((spot) => ({ ...spot })),
  panels: 'opaque',
  radius: 'doux',
  text: 'normal',
  watermark: false,
  markOpacity: 6,
  markSize: 100,
  markColor: null,
  markImage: null,
  markMode: 'silhouette',
};

const oneOf = <T extends string>(list: readonly T[], value: unknown, fallback: T): T => (list.includes(value as T) ? (value as T) : fallback);

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

const isHex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** Les filigranes importés doivent rester compatibles avec le stockage local. */
const isSafeMarkImage = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 2_000_000 && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/i.test(value);

/** Relit un objet stocké en ne gardant que ce qui est valide. */
export function parseAppearance(raw: unknown): Appearance {
  const value = (raw ?? {}) as Partial<Appearance>;
  const colors = value.colors;
  return {
    gradient: oneOf(GRADIENTS, value.gradient, DEFAULT_APPEARANCE.gradient),
    intensity: parseIntensity(value.intensity),
    colors: colors && isHex(colors.from) && isHex(colors.to) ? { from: colors.from, to: colors.to } : null,
    // De un à six foyers, bornés à la fenêtre : un fichier de thème partagé
    // peut porter n'importe quoi, y compris un tableau vide ou de mille
    // entrées.
    spots: parseSpots(value.spots),
    panels: oneOf(PANEL_MODES, value.panels, DEFAULT_APPEARANCE.panels),
    radius: oneOf(RADIUS_SCALES, value.radius, DEFAULT_APPEARANCE.radius),
    text: oneOf(TEXT_SCALES, value.text, DEFAULT_APPEARANCE.text),
    watermark: typeof value.watermark === 'boolean' ? value.watermark : DEFAULT_APPEARANCE.watermark,
    // Bornés : un filigrane à 100 % d'opacité couvrirait l'interface, et une
    // taille délirante ne se rattraperait qu'en vidant le stockage.
    markOpacity: clampNumber(value.markOpacity, 0, 30, DEFAULT_APPEARANCE.markOpacity),
    markSize: clampNumber(value.markSize, 20, 200, DEFAULT_APPEARANCE.markSize),
    markColor: isHex(value.markColor) ? value.markColor : null,
    // Seules les images en data-URI sont reprises : un chemin ou une URL
    // externe serait de toute façon refusé par la CSP.
    markImage: isSafeMarkImage(value.markImage) ? value.markImage : null,
    markMode: oneOf(MARK_MODES, value.markMode, DEFAULT_APPEARANCE.markMode),
  };
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function parseSpots(raw: unknown): GradientSpot[] {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_SPOTS) : [];
  const spots = list.map((entry, index) => {
    const fallback = DEFAULT_SPOTS[index] ?? DEFAULT_SPOTS[0];
    const spot = entry as Partial<GradientSpot> | null;
    return {
      shape: oneOf(SPOT_SHAPES, spot?.shape, fallback.shape),
      x: clampNumber(spot?.x, -20, 120, fallback.x),
      y: clampNumber(spot?.y, -20, 120, fallback.y),
      size: clampNumber(spot?.size, 10, 120, fallback.size),
      angle: clampNumber(spot?.angle, 0, 360, fallback.angle),
      color: (spot?.color === 1 ? 1 : 0) as 0 | 1,
      tint: isHex(spot?.tint) ? spot.tint : null,
      alpha: clampNumber(spot?.alpha, 10, 200, 100),
    };
  });
  // Jamais zéro : le motif « libre » sans foyer n'affiche rien, et rien ne
  // permettrait d'en rajouter un depuis l'aperçu vide.
  return spots.length ? spots : DEFAULT_SPOTS.map((spot) => ({ ...spot }));
}
