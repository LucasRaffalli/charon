export const THEMES = ['light', 'dark', 'contrast', 'unicorn'] as const;

export type Theme = (typeof THEMES)[number];

export function isTheme(value: string | null): value is Theme {
  return THEMES.includes(value as Theme);
}
