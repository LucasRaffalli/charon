export type DiffLineType = 'ctx' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** Au-delà, le diff n'est pas calculé (coût mémoire de la LCS). */
const MAX_LINES = 2000;

/**
 * Diff par lignes (plus longue sous-séquence commune). `before` = contenu
 * actuel du serveur, `after` = contenu local à envoyer : `del` = lignes que
 * l'écrasement retire, `add` = lignes qu'il ajoute. `null` si trop volumineux.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if (n > MAX_LINES || m > MAX_LINES) {
    return null;
  }

  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i++] });
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j++] });
  }
  return out;
}

/** Une cellule d'une colonne de la vue côte à côte. */
export interface SplitCell {
  num: number;
  text: string;
}

/** Une ligne de la vue côte à côte : gauche = serveur actuel, droite = local. */
export interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
  changed: boolean;
}

/**
 * Transforme un diff unifié en lignes appariées gauche/droite (vue « merge ») :
 * les suppressions vont à gauche, les ajouts à droite, alignés par bloc de
 * changement ; les lignes de contexte occupent les deux colonnes.
 */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let leftNum = 0;
  let rightNum = 0;
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  const flush = (): void => {
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null, changed: true });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.type === 'ctx') {
      flush();
      leftNum++;
      rightNum++;
      rows.push({
        left: { num: leftNum, text: line.text },
        right: { num: rightNum, text: line.text },
        changed: false,
      });
    } else if (line.type === 'del') {
      leftNum++;
      dels.push({ num: leftNum, text: line.text });
    } else {
      rightNum++;
      adds.push({ num: rightNum, text: line.text });
    }
  }
  flush();
  return rows;
}

/** Compte les lignes ajoutées / retirées d'un diff. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') {
      added++;
    } else if (line.type === 'del') {
      removed++;
    }
  }
  return { added, removed };
}
