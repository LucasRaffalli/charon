/** Panneaux dockables de l'explorateur. */
export type DockPanelId =
  | 'local'
  | 'tree'
  | 'server'
  | 'preview'
  | 'transfers'
  | 'journal'
  | 'logs'
  | 'terminal';

/** Feuille : groupe de panneaux à onglets (au moins un panneau). */
export interface DockGroup {
  kind: 'group';
  id: string;
  panels: DockPanelId[];
  active: DockPanelId;
}

/** Nœud interne : division horizontale (row) ou verticale (column). */
export interface DockSplit {
  kind: 'split';
  id: string;
  dir: 'row' | 'column';
  children: DockNode[];
  /** Fractions de la place de chaque enfant (somme ≈ 1). */
  sizes: number[];
}

export type DockNode = DockSplit | DockGroup;

/** Zone de dépôt sur un groupe : centre = onglet, bords = split. */
export type DockZone = 'center' | 'top' | 'bottom' | 'left' | 'right';

/** Glissement d'onglet en cours. */
export interface DockDrag {
  panel: DockPanelId;
  fromGroup: string;
  x: number;
  y: number;
}

/** Cible de dépôt courante pendant un glissement. */
export interface DockDropTarget {
  groupId: string;
  zone: DockZone;
}
