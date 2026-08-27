import { Injectable, computed, effect, signal } from '@angular/core';

import { IconName } from '@app/components/ui/icon/icon';
import {
  DockDrag,
  DockDropTarget,
  DockGroup,
  DockNode,
  DockPanelId,
  DockSplit,
  DockZone,
} from '@app/interfaces';
import {
  ALL_PANELS,
  DOCK_LAYOUTS,
  DockLayout,
  collectGroups,
  collectPanels,
  defaultTree,
  insertAtZone,
  isValidTree,
  mapNode,
  removePanel,
  wrapRoot,
} from '@app/services/dock-tree';

/** Libellé + icône de chaque panneau dockable. */
export const PANEL_META: Record<DockPanelId, { label: string; icon: IconName }> = {
  local: { label: 'Local', icon: 'monitor' },
  tree: { label: 'Arborescence', icon: 'server' },
  server: { label: 'Serveur', icon: 'folder' },
  preview: { label: 'Aperçu', icon: 'file' },
  transfers: { label: 'Transferts', icon: 'arrow-down-up' },
  journal: { label: 'Journal', icon: 'info' },
  logs: { label: 'Logs', icon: 'logs' },
  terminal: { label: 'Terminal', icon: 'terminal' },
  modules: { label: 'Modules', icon: 'layout-grid' },
};

/** Bord de réouverture d'un panneau fermé, selon sa nature. */
const REOPEN_ZONES: Record<DockPanelId, DockZone> = {
  local: 'left',
  tree: 'left',
  server: 'left',
  preview: 'right',
  transfers: 'bottom',
  journal: 'bottom',
  logs: 'bottom',
  terminal: 'bottom',
  modules: 'right',
};

const STORAGE_KEY = 'charon:dock';

/** Fraction minimale d'un enfant de split (évite les zones écrasées). */
const MIN_FRACTION = 0.08;

/** Cible de dépôt spéciale : les bords de tout l'espace de travail. */
export const ROOT_TARGET = '#root';

interface StoredLayout {
  version: number;
  tree: DockNode;
}

/**
 * Disposition des panneaux de l'explorateur : arbre de splits + groupes à
 * onglets, persisté. Toutes les mutations passent par ici (drag & drop,
 * redimensionnement, activation d'onglet, réinitialisation).
 */
@Injectable({ providedIn: 'root' })
export class DockService {
  private readonly _tree = signal<DockNode>(this.load());
  readonly tree = this._tree.asReadonly();

  /** Les dispositions toutes faites, proposées dans le mode design. */
  readonly layouts = DOCK_LAYOUTS;

  /**
   * Le mode design est un brouillon : tant que c'est faux, la disposition
   * s'applique à l'écran mais ne s'écrit pas dans le stockage.
   */
  private readonly persisting = signal(true);

  /** Glissement d'onglet en cours (position en coordonnées viewport). */
  readonly drag = signal<DockDrag | null>(null);
  /** Cible de dépôt survolée pendant le glissement. */
  readonly dropTarget = signal<DockDropTarget | null>(null);

  /** Panneaux actuellement visibles (onglet actif de leur groupe). */
  readonly activePanels = computed<ReadonlySet<DockPanelId>>(
    () => new Set(collectGroups(this.tree()).map((g) => g.active)),
  );

  /** Tous les groupes de l'arbre (ordre de parcours stable). */
  readonly groups = computed(() => collectGroups(this.tree()));

  /** Signature structurelle : ne change que si des panneaux changent de
   *  groupe (pas au resize ni à l'activation d'onglet). */
  readonly structure = computed(() =>
    collectGroups(this.tree())
      .map((g) => `${g.id}:${g.panels.join(',')}`)
      .join('|'),
  );

  /** Panneaux présents dans la disposition. */
  readonly openPanels = computed<ReadonlySet<DockPanelId>>(
    () => new Set(collectPanels(this.tree())),
  );

  /** Panneaux fermés (à proposer en réouverture). */
  readonly closedPanels = computed<DockPanelId[]>(() => {
    const open = this.openPanels();
    return ALL_PANELS.filter((panel) => !open.has(panel));
  });

  constructor() {
    // Persistance débouncée : un resize émet ~60 arbres/s, on n'écrit
    // qu'une fois le geste posé.
    effect((onCleanup) => {
      const stored: StoredLayout = { version: 1, tree: this.tree() };
      if (!this.persisting()) {
        return;
      }
      const handle = setTimeout(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      }, 300);
      onCleanup(() => clearTimeout(handle));
    });
  }

  private load(): DockNode {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredLayout;
        if (parsed.version === 1 && isValidTree(parsed.tree)) {
          return parsed.tree;
        }
      }
    } catch {
      // disposition corrompue : on repart du défaut
    }
    return defaultTree();
  }

  /** Active un onglet dans son groupe. */
  activate(groupId: string, panel: DockPanelId): void {
    this._tree.update((tree) =>
      mapNode(tree, groupId, (n) => ({ ...(n as DockGroup), active: panel })),
    );
  }

  /** Rend un panneau visible (active son onglet), où qu'il soit docké. */
  focusPanel(panel: DockPanelId): void {
    const owner = collectGroups(this.tree()).find((g) => g.panels.includes(panel));
    if (owner) {
      this.activate(owner.id, panel);
    }
  }

  /** Glissement d'une poignée de resize en cours (coupe les animations). */
  readonly resizing = signal(false);

  /** Déplace un panneau vers `zone` du groupe cible (fin de drag & drop). */
  movePanel(panel: DockPanelId, targetGroupId: string, zone: DockZone): void {
    // Bord de la fenêtre : le panneau prend tout un côté de l'espace
    // de travail, le reste du layout est poussé de l'autre côté.
    if (targetGroupId === ROOT_TARGET) {
      if (zone === 'center') {
        return;
      }
      const without = removePanel(this.tree(), panel);
      if (!without) {
        return;
      }
      this._tree.set(wrapRoot(without, panel, zone));
      return;
    }

    const tree = this.tree();
    const target = collectGroups(tree).find((g) => g.id === targetGroupId);
    if (!target) {
      return;
    }
    // Dépôt sur son propre groupe : au centre = simple activation ; sur un
    // bord d'un groupe qui ne contient que lui = déjà en place.
    if (target.panels.includes(panel) && (zone === 'center' || target.panels.length === 1)) {
      this.activate(targetGroupId, panel);
      return;
    }

    const without = removePanel(tree, panel);
    if (!without) {
      return;
    }
    // La cible peut avoir disparu (groupe source vidé) : abandon propre.
    if (!collectGroups(without).some((g) => g.id === targetGroupId)) {
      return;
    }
    this._tree.set(insertAtZone(without, targetGroupId, panel, zone));
  }

  /**
   * Redimensionne deux enfants adjacents d'un split : `startSizes` est la
   * photo des fractions au début du glissement, `deltaFraction` le déplacement.
   */
  resizeSplit(splitId: string, index: number, startSizes: number[], deltaFraction: number): void {
    this._tree.update((tree) =>
      mapNode(tree, splitId, (n) => {
        const s = n as DockSplit;
        const pair = startSizes[index] + startSizes[index + 1];
        const first = Math.min(
          pair - MIN_FRACTION,
          Math.max(MIN_FRACTION, startSizes[index] + deltaFraction),
        );
        const sizes = [...startSizes];
        sizes[index] = first;
        sizes[index + 1] = pair - first;
        return { ...s, sizes };
      }),
    );
  }

  /** Ferme un panneau (la vue serveur reste toujours ouverte). */
  closePanel(panel: DockPanelId): void {
    if (panel === 'server') {
      return;
    }
    const without = removePanel(this.tree(), panel);
    if (without) {
      this._tree.set(without);
    }
  }

  /** (R)ouvre un panneau : le focalise s'il est présent, sinon l'insère
   *  sur son bord naturel (outils en bas, aperçu à droite, fichiers à gauche). */
  openPanel(panel: DockPanelId): void {
    if (this.openPanels().has(panel)) {
      this.focusPanel(panel);
      return;
    }
    this._tree.set(wrapRoot(this.tree(), panel, REOPEN_ZONES[panel]));
  }

  /** Revient à la disposition par défaut. */
  reset(): void {
    this._tree.set(defaultTree());
  }

  /** Applique une disposition toute faite. */
  applyLayout(layout: DockLayout): void {
    this._tree.set(layout.build());
  }

  setPersisting(on: boolean): void {
    this.persisting.set(on);
  }

  /** Repose un arbre tel quel (retour en arrière du mode design). */
  restoreTree(tree: DockNode): void {
    this._tree.set(tree);
  }

  // --- Drag & drop d'onglets ---

  beginDrag(panel: DockPanelId, fromGroup: string, x: number, y: number): void {
    this.drag.set({ panel, fromGroup, x, y });
  }

  updateDrag(x: number, y: number): void {
    const current = this.drag();
    if (current) {
      this.drag.set({ ...current, x, y });
    }
  }

  /** Termine le glissement ; `commit` = appliquer la cible courante. */
  endDrag(commit: boolean): void {
    const drag = this.drag();
    const target = this.dropTarget();
    this.drag.set(null);
    this.dropTarget.set(null);
    if (commit && drag && target) {
      this.movePanel(drag.panel, target.groupId, target.zone);
    }
  }
}
