// L'accent porte la rampe de couleur, et pour certains une teinte que les
// élévations absorbent. Il se combine à n'importe quel thème.
//
// `unicorn` est caché : il ne se déverrouille qu'en tapant son nom dans la
// palette de commandes, et n'apparaît ensuite que dans les réglages.
export const ACCENTS = ['charon', 'unloved', 'jade', 'unicorn'] as const;

export type Accent = (typeof ACCENTS)[number];

export function isAccent(value: string | null): value is Accent {
  return ACCENTS.includes(value as Accent);
}
