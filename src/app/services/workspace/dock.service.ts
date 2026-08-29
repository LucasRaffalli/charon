import { Injectable, computed, effect, signal } from '@angular/core';
import { scopedKey } from '@app/services/system/window-scope';

import { IconName } from '@app/components/ui/icon/icon';
import { DockDrag, DockDropTarget, DockGroup, DockNode, DockPanelId, DockSplit, DockZone } from '@app/interfaces';
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
  PANEL_OPEN_SHARE,
  removePanel,
  wrapRoot,
} from '@app/services/workspace/dock-tree';

/** Libellé + icône de chaque panneau dockable. */
/** Ce qu'un panneau emprunte à la session qu'il montre. */
export interface PanelIdentity {
  /** Couleur de session, pour teinter la barre d'onglets. */
  tint: string;
  /** Nom du serveur, ajouté au libellé de l'onglet. */
  name: string;
  /**
   * Le bord d'où part la couleur. En vue double les deux panneaux se font
   * face : la couleur se pose sur leurs bords EXTÉRIEURS et le centre, là où
   * ils se touchent, reste calme.
   */
  side: 'left' | 'right';
}

export const PANEL_META: Record<DockPanelId, { label: string; icon: IconName }> = {
  local: { label: 'Local', icon: 'monitor' },
  tree: { label: 'Arborescence', icon: 'server' },
  server: { label: 'Serveur', icon: 'folder' },
  preview: { label: 'Aperçu', icon: 'file' },
  transfers: { label: 'Transferts', icon: 'arrow-down-up' },
  journal: { label: 'Journal', icon: 'info' },
  logs: { label: 'Logs', icon: 'logs' },
  terminal: { label: 'Terminal', icon: 'terminal' },
  favorites: { label: 'Favoris', icon: 'anchor' },
  server2: { label: 'Serveur 2', icon: 'server' },
  terminal2: { label: 'Terminal 2', icon: 'terminal' },
  modules: { label: 'Modules', icon: 'layout-grid' },
  search: { label: 'Recherche', icon: 'search' },
  trash: { label: 'Corbeille', icon: 'trash' },
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
  favorites: 'left',
  server2: 'left',
  terminal2: 'bottom',
  modules: 'right',
  search: 'right',
  trash: 'bottom',
};

// Par fenêtre : voir scopedKey. Ce qui appartient à une session ne doit
// pas être écrasé par la fenêtre d'à côté.
const STORAGE_KEY = scopedKey('charon:dock');

/** Fraction minimale d'un enfant de split (évite les zones écrasées). */
const MIN_FRACTION = 0.08;

/**
 * Pendant le glissé, un panneau peut descendre jusqu'à cette largeur (px) :
 * assez bas pour qu'on SENTE qu'on va au bout, sans disparaître d'un coup
 * sous le curseur.
 */
const MIN_DRAG_PX = 48;

/**
 * Sous cette taille (px) AU RELÂCHEMENT, le panneau se ferme au lieu de rester
 * en bande illisible où les boutons se chevauchent. Tirer une poignée jusqu'au
 * bord est le geste naturel pour ranger un panneau ; il reste réouvrable
 * depuis la barre de statut, ⌘1-9 ou la palette.
 */
const COLLAPSE_PX = 96;

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
/** Retrouve un split par son identifiant (pour la fermeture au relâchement). */
const findSplit = (node: DockNode, id: string): DockSplit | null => {
  if (node.kind === 'split') {
    if (node.id === id) {
      return node;
    }
    for (const child of node.children) {
      const found = findSplit(child, id);
      if (found) {
        return found;
      }
    }
  }
  return null;
};

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
  readonly activePanels = computed<ReadonlySet<DockPanelId>>(() => new Set(collectGroups(this.tree()).map((g) => g.active)));

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
  readonly openPanels = computed<ReadonlySet<DockPanelId>>(() => new Set(collectPanels(this.tree())));

  /** Panneaux fermés (à proposer en réouverture). */
  /**
   * L'identité d'un panneau : la couleur de sa barre d'onglets et le nom qu'il
   * porte. Le dock ne connaît pas les sessions, l'explorateur pose cette table
   * et le dock se contente de l'afficher. Vide par défaut : un panneau
   * ordinaire garde sa barre neutre et son libellé d'origine.
   */
  private readonly _identities = signal<Partial<Record<DockPanelId, PanelIdentity>>>({});
  readonly identities = this._identities.asReadonly();

  setIdentities(identities: Partial<Record<DockPanelId, PanelIdentity>>): void {
    this._identities.set(identities);
  }

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
    this._tree.update((tree) => mapNode(tree, groupId, (n) => ({ ...(n as DockGroup), active: panel })));
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
  /**
   * Les panneaux qui se fermeraient si on relâchait maintenant. Le glissé les
   * estompe : une fermeture sans préavis passerait pour une disparition.
   */
  private readonly _nearCollapse = signal<ReadonlySet<DockPanelId>>(new Set());
  readonly nearCollapse = this._nearCollapse.asReadonly();

  resizeSplit(
    splitId: string,
    index: number,
    startSizes: number[],
    deltaFraction: number,
    containerPx = 0,
  ): void {
    this._tree.update((tree) =>
      mapNode(tree, splitId, (n) => {
        const s = n as DockSplit;
        const pair = startSizes[index] + startSizes[index + 1];
        // Le plancher se dit en PIXELS : une fraction fixe laisse un panneau
        // devenir illisible sur un grand écran et bloque trop tôt sur un
        // petit. Jamais plus que la moitié de la paire, sinon la poignée se
        // retrouverait coincée dans une fenêtre étroite.
        const min =
          containerPx > 0
            ? Math.min(pair / 2, MIN_DRAG_PX / containerPx)
            : MIN_FRACTION;
        const first = Math.min(pair - min, Math.max(min, startSizes[index] + deltaFraction));
        const sizes = [...startSizes];
        sizes[index] = first;
        sizes[index + 1] = pair - first;

        // Annonce du sort réservé aux deux enfants concernés.
        const doomed = new Set<DockPanelId>();
        if (containerPx > 0) {
          for (const i of [index, index + 1]) {
            if (sizes[i] * containerPx < COLLAPSE_PX) {
              collectPanels(s.children[i]).forEach((panel) => doomed.add(panel));
            }
          }
        }
        this._nearCollapse.set(doomed);

        return { ...s, sizes };
      }),
    );
  }

  /**
   * Fin d'un glissé de poignée : un enfant réduit sous `COLLAPSE_PX` est
   * FERMÉ plutôt que laissé en bande inutilisable. C'est le geste attendu
   * d'un dock (tirer jusqu'au bord range le panneau), et ça évite l'état où
   * les boutons d'un en-tête se marchent dessus faute de largeur.
   *
   * Tous les panneaux du sous-arbre concerné partent ensemble : un groupe
   * réduit à rien emmène ses onglets, qui restent réouvrables.
   */
  collapseIfTiny(splitId: string, containerPx: number): void {
    this._nearCollapse.set(new Set());
    if (containerPx <= 0) {
      return;
    }
    const target = findSplit(this.tree(), splitId);
    if (!target) {
      return;
    }
    const doomed = target.children
      .filter((_, i) => (target.sizes[i] ?? 1) * containerPx < COLLAPSE_PX)
      .flatMap((child) => collectPanels(child));
    for (const panel of doomed) {
      this.closePanel(panel);
    }
  }

  /**
   * Ouvre `panel` en scindant le groupe qui contient `anchor`, du côté
   * `zone` : « Terminal 2 » se pose À CÔTÉ du terminal, pas sur le bord bas
   * de tout l'espace. Si l'ancre est fermée, le bord naturel fait l'affaire.
   */
  openBeside(panel: DockPanelId, anchor: DockPanelId, zone: DockZone): void {
    if (this.openPanels().has(panel)) {
      this.focusPanel(panel);
      return;
    }
    const group = collectGroups(this.tree()).find((candidate) => candidate.panels.includes(anchor));
    if (!group) {
      this.openPanel(panel);
      return;
    }
    this._tree.set(insertAtZone(this.tree(), group.id, panel, zone));
  }

  /** Ferme un panneau (la vue serveur reste toujours ouverte). */
  /**
   * Ferme un panneau. Le panneau serveur n'est plus une exception : il se
   * ferme et se rouvre comme les autres, depuis la barre de statut ou ⌘1.
   * `removePanel` rend `null` quand il ne resterait plus rien, ce qui protège
   * le dernier panneau ouvert sans qu'il faille nommer lequel.
   */
  closePanel(panel: DockPanelId): void {
    const without = removePanel(this.tree(), panel);
    if (without) {
      this._tree.set(without);
    }
  }

  /**
   * (R)ouvre un panneau : le focalise s'il est déjà là, sinon il rejoint ses
   * semblables.
   *
   * Un panneau rouvert cherche d'abord un groupe qui accueille déjà des
   * panneaux du même bord et s'y range EN ONGLET. Rouvrir « Journal » quand
   * « Transferts » et « Terminal » occupent le bas rend un troisième onglet,
   * là où l'ancienne version taillait systématiquement un nouveau split et
   * réduisait la zone à chaque réouverture. À défaut de semblable (tout a été
   * fermé), le panneau reprend son bord naturel : outils en bas, aperçu à
   * droite, fichiers à gauche.
   */
  openPanel(panel: DockPanelId): void {
    if (this.openPanels().has(panel)) {
      this.focusPanel(panel);
      return;
    }
    const zone = REOPEN_ZONES[panel];
    // Le regroupement ne vaut que pour la barre d'outils du BAS, dont les
    // panneaux (transferts, journal, logs, terminal, corbeille) vivent
    // ensemble par nature. À gauche et à droite chacun a sa colonne : y
    // fusionner masquerait un voisin, et l'arborescence rouverte prenait
    // ainsi la place du panneau local (ou pire, du panneau serveur).
    const host =
      zone === 'bottom'
        ? collectGroups(this.tree()).find((candidate) =>
            candidate.panels.some((open) => REOPEN_ZONES[open] === 'bottom'),
          )
        : undefined;
    this._tree.set(
      host
        ? insertAtZone(this.tree(), host.id, panel, 'center')
        : wrapRoot(this.tree(), panel, zone, PANEL_OPEN_SHARE[panel]),
    );
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
