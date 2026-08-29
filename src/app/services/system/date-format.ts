/**
 * Horodatages via `Intl`, mémoïsés au chargement du module.
 *
 * Le `DatePipe` d'Angular embarquait ~40 Ko de tables de locale (mois en
 * toutes lettres, ères, fuseaux) pour trois usages qui n'affichent que des
 * chiffres. `Intl.DateTimeFormat` fait le même rendu avec ce que le système
 * sait déjà.
 */
const CLOCK = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const STAMP = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** `HH:mm:ss` (journal, barre d'édition distante). */
export const formatClock = (at: number): string => CLOCK.format(at);

/** `dd/MM/yy HH:mm` (dialogue d'écrasement). */
export const formatStamp = (at: number): string => STAMP.format(at).replace(',', '');
