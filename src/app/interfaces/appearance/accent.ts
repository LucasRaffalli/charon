// L'accent porte la rampe de couleur, et pour certains une teinte que les
// élévations absorbent. Il se combine à n'importe quel thème.
//
// `unicorn` et `stars` sont cachés : ils ne se déverrouillent qu'en tapant
// une séquence de touches n'importe où dans l'application (voir
// SecretAccentService), et n'apparaissent ensuite que dans les réglages, tant
// qu'ils restent actifs.
export const ACCENTS = ['charon', 'unloved', 'jade', 'unicorn', 'stars'] as const;

export type Accent = (typeof ACCENTS)[number];

export function isAccent(value: string | null): value is Accent {
  return ACCENTS.includes(value as Accent);
}
