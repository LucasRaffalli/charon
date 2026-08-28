/**
 * Permissions POSIX : la traduction entre les trois façons de les dire.
 *
 * L'octal (`755`) est ce que le serveur attend, la chaîne `rwxr-xr-x` est ce
 * qu'on lit dans un `ls`, et les neuf cases à cocher sont ce qu'on manipule.
 * Les trois désignent la même chose, et ce module fait la conversion dans les
 * deux sens plutôt que de la refaire à trois endroits.
 */

/** Les trois classes d'un mode POSIX, dans l'ordre des chiffres octaux. */
export const PERM_CLASSES = ['owner', 'group', 'others'] as const;
export type PermClass = (typeof PERM_CLASSES)[number];

/** Les trois droits, dans l'ordre des bits. */
export const PERM_BITS = ['read', 'write', 'exec'] as const;
export type PermBit = (typeof PERM_BITS)[number];

/** Poids d'un droit dans son chiffre octal. */
const WEIGHT: Record<PermBit, number> = { read: 4, write: 2, exec: 1 };

/** Décalage d'une classe : le propriétaire occupe les bits les plus hauts. */
const SHIFT: Record<PermClass, number> = { owner: 6, group: 3, others: 0 };

export function hasPerm(mode: number, cls: PermClass, bit: PermBit): boolean {
  return (mode & (WEIGHT[bit] << SHIFT[cls])) !== 0;
}

export function togglePerm(mode: number, cls: PermClass, bit: PermBit): number {
  return mode ^ (WEIGHT[bit] << SHIFT[cls]);
}

/** Le mode en octal, tel qu'on l'écrit dans un chmod (« 755 »). */
export function toOctal(mode: number): string {
  const special = (mode >> 9) & 0o7;
  const base = (mode & 0o777).toString(8).padStart(3, '0');
  // Les bits spéciaux (setuid, setgid, sticky) ne s'écrivent que s'ils
  // existent : un « 0755 » gratuit ferait croire qu'on en a posé un.
  return special ? `${special}${base}` : base;
}

/**
 * La lettre de chaque droit. Explicite, et non dérivée du nom : `exec`
 * commence par un `e`, mais s'écrit `x`.
 */
const LETTER: Record<PermBit, string> = { read: 'r', write: 'w', exec: 'x' };

/** Le mode en lettres, comme dans un `ls -l` (« rwxr-xr-x »). */
export function toSymbolic(mode: number): string {
  return PERM_CLASSES.map((cls) =>
    PERM_BITS.map((bit) => (hasPerm(mode, cls, bit) ? LETTER[bit] : '-')).join(''),
  ).join('');
}
