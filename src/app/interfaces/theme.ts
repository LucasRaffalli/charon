// Le thème porte les neutres et les niveaux. La couleur, elle, vient de
// l'accent (voir `accent.ts`) : les deux sont indépendants.
export const THEMES = ['light', 'dark', 'contrast'] as const;

export type Theme = (typeof THEMES)[number];

export function isTheme(value: string | null): value is Theme {
  return THEMES.includes(value as Theme);
}
