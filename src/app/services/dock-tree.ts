import { DockGroup, DockNode, DockPanelId, DockSplit, DockZone } from '@app/interfaces';

/**
 * Fonctions pures de manipulation de l'arbre du dock (aucune dépendance
 * Angular) : testables en isolation, utilisées par DockService.
 */

export const ALL_PANELS: readonly DockPanelId[] = [
  'local',
  'tree',
  'server',
  'preview',
  'transfers',
  'journal',
  'logs',
  'terminal',
  // Fermé par défaut : ouvert à la volée quand un module appelle ui.render.
  'modules',
];

/** Part de l'espace donnée à un panneau déposé sur un bord de la fenêtre. */
export const ROOT_DROP_SHARE = 0.24;

let nextId = 0;
const id = (): string => `n${++nextId}-${Math.random().toString(36).slice(2, 7)}`;

export const group = (panels: DockPanelId[], active?: DockPanelId): DockGroup => ({
  kind: 'group',
  id: id(),
  panels,
  active: active ?? panels[0],
});

export const split = (
  dir: 'row' | 'column',
  children: DockNode[],
  sizes: number[],
): DockSplit => ({
  kind: 'split',
  id: id(),
  dir,
  children,
  sizes,
});

/** Disposition par défaut : sidebar (local + arbre), serveur, aperçu, zone basse. */
export const defaultTree = (): DockNode =>
  split(
    'column',
    [
      split(
        'row',
        [
          split('column', [group(['local']), group(['tree'])], [0.55, 0.45]),
          group(['server']),
          group(['preview']),
        ],
        [0.24, 0.52, 0.24],
      ),
      group(['transfers', 'journal', 'logs', 'terminal']),
    ],
    [0.74, 0.26],
  );

/** Une disposition toute faite, proposée dans le mode design. */
export interface DockLayout {
  label: string;
  hint: string;
  build: () => DockNode;
}

const BOTTOM: DockPanelId[] = ['transfers', 'journal', 'logs', 'terminal'];

/**
 * Les dispositions proposées. Un panneau absent d'une disposition n'est pas
 * perdu : il rejoint les panneaux fermés, et se rouvre depuis la barre de
 * statut.
 */
export const DOCK_LAYOUTS: readonly DockLayout[] = [
  {
    label: 'Classique',
    hint: 'Local et arborescence à gauche, serveur au centre, aperçu à droite.',
    build: defaultTree,
  },
  {
    label: 'Deux colonnes',
    hint: 'Local et serveur côte à côte, comme un client FTP classique.',
    build: () =>
      split('column', [split('row', [group(['local']), group(['server'])], [0.5, 0.5]), group(BOTTOM)], [0.72, 0.28]),
  },
  {
    label: 'Serveur',
    hint: 'Le distant en grand, sans zone basse.',
    build: () =>
      split('row', [group(['tree']), group(['server']), group(['preview'])], [0.2, 0.56, 0.24]),
  },
  {
    label: 'Terminal',
    hint: 'Serveur à gauche, terminal en grand à droite.',
    build: () =>
      split(
        'column',
        [
          split('row', [group(['server']), group(['terminal'])], [0.45, 0.55]),
          group(['transfers', 'journal', 'logs']),
        ],
        [0.78, 0.22],
      ),
  },
  {
    label: 'Épuré',
    hint: 'Local et serveur, rien d\'autre.',
    build: () => split('row', [group(['local']), group(['server'])], [0.5, 0.5]),
  },
];

export const collectGroups = (node: DockNode, out: DockGroup[] = []): DockGroup[] => {
  if (node.kind === 'group') {
    out.push(node);
  } else {
    node.children.forEach((child) => collectGroups(child, out));
  }
  return out;
};

export const collectPanels = (node: DockNode): DockPanelId[] =>
  collectGroups(node).flatMap((g) => g.panels);

/** Retire un panneau ; les groupes vides disparaissent, les splits se normalisent. */
export const removePanel = (node: DockNode, panel: DockPanelId): DockNode | null => {
  if (node.kind === 'group') {
    if (!node.panels.includes(panel)) {
      return node;
    }
    const panels = node.panels.filter((p) => p !== panel);
    if (panels.length === 0) {
      return null;
    }
    return { ...node, panels, active: panels.includes(node.active) ? node.active : panels[0] };
  }

  const children: DockNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const kept = removePanel(child, panel);
    if (kept) {
      children.push(kept);
      sizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  });
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0];
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...node, children, sizes: sizes.map((s) => s / total) };
};

/** Remplace un nœud (par id) via un transformateur. */
export const mapNode = (
  node: DockNode,
  targetId: string,
  fn: (n: DockNode) => DockNode,
): DockNode => {
  if (node.id === targetId) {
    return fn(node);
  }
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => mapNode(c, targetId, fn)) };
  }
  return node;
};

/** Insère `panel` sur `zone` du groupe cible. */
export const insertAtZone = (
  tree: DockNode,
  targetGroupId: string,
  panel: DockPanelId,
  zone: DockZone,
): DockNode => {
  if (zone === 'center') {
    return mapNode(tree, targetGroupId, (n) => {
      const g = n as DockGroup;
      return { ...g, panels: [...g.panels, panel], active: panel };
    });
  }

  const dir: 'row' | 'column' = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const before = zone === 'left' || zone === 'top';

  const wrap = (n: DockNode): DockNode => {
    const fresh = group([panel]);
    const children = before ? [fresh, n] : [n, fresh];
    return split(dir, children, [0.5, 0.5]);
  };

  // Si le parent direct est déjà un split dans la bonne direction, on insère
  // à côté plutôt que d'imbriquer un split inutile.
  const insertInParent = (node: DockNode): DockNode => {
    if (node.kind === 'split') {
      const index = node.children.findIndex((c) => c.id === targetGroupId);
      if (index !== -1 && node.dir === dir) {
        const fresh = group([panel]);
        const at = before ? index : index + 1;
        const children = [...node.children];
        children.splice(at, 0, fresh);
        const sizes = [...node.sizes];
        const share = sizes[index] / 2;
        sizes[index] = share;
        sizes.splice(at, 0, share);
        return { ...node, children, sizes };
      }
      return { ...node, children: node.children.map(insertInParent) };
    }
    return node.id === targetGroupId ? wrap(node) : node;
  };

  if (tree.id === targetGroupId) {
    return wrap(tree);
  }
  return insertInParent(tree);
};

/** Enveloppe l'arbre : `panel` prend le bord `zone` de l'espace de travail. */
export const wrapRoot = (tree: DockNode, panel: DockPanelId, zone: DockZone): DockNode => {
  const dir: 'row' | 'column' = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const before = zone === 'left' || zone === 'top';
  const fresh = group([panel]);
  const children = before ? [fresh, tree] : [tree, fresh];
  const sizes = before
    ? [ROOT_DROP_SHARE, 1 - ROOT_DROP_SHARE]
    : [1 - ROOT_DROP_SHARE, ROOT_DROP_SHARE];
  return split(dir, children, sizes);
};

/** Un arbre est valide : panneaux uniques, serveur présent, structure saine. */
export const isValidTree = (node: unknown): node is DockNode => {
  const check = (n: any): boolean => {
    if (!n || typeof n !== 'object') {
      return false;
    }
    if (n.kind === 'group') {
      return (
        Array.isArray(n.panels) &&
        n.panels.length > 0 &&
        n.panels.every((p: unknown) => ALL_PANELS.includes(p as DockPanelId)) &&
        n.panels.includes(n.active)
      );
    }
    if (n.kind === 'split') {
      return (
        Array.isArray(n.children) &&
        n.children.length > 1 &&
        Array.isArray(n.sizes) &&
        n.sizes.length === n.children.length &&
        n.children.every(check)
      );
    }
    return false;
  };
  if (!check(node)) {
    return false;
  }
  const panels = collectPanels(node as DockNode);
  return panels.length === new Set(panels).size && panels.includes('server');
};
