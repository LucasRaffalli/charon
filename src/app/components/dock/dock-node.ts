import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  forwardRef,
  inject,
  input,
} from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { ResizeHandle } from '@app/components/ui/resize-handle/resize-handle';
import { DockGroup, DockNode, DockPanelId, DockSplit, DockZone } from '@app/interfaces';
import { ContextMenuItem, ContextMenuService } from '@app/services/workspace/context-menu.service';
import { DockService, PANEL_META, ROOT_TARGET } from '@app/services/workspace/dock.service';
import { SessionRegistry } from '@app/services/connection/session-registry';

/** Distance (px) avant qu'un appui sur un onglet devienne un glissement. */
const DRAG_THRESHOLD = 5;

/**
 * Rendu récursif d'un nœud du dock : split (avec poignées de resize entre
 * enfants) ou groupe à onglets. Les onglets se glissent d'un groupe à
 * l'autre (drop au centre = onglet, sur un bord = nouveau split).
 * Le CONTENU des panneaux n'est pas rendu ici : le composant racine Dock
 * déplace les éléments du hangar vers les slots (état préservé).
 */
@Component({
  selector: 'app-dock-node',
  imports: [Icon, ResizeHandle, forwardRef(() => DockNodeView)],
  templateUrl: './dock-node.html',
  styleUrl: './dock-node.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DockNodeView {
  protected readonly dock = inject(DockService);

  constructor() {
    // Un nœud détruit en plein glissé (réagencement de l'arbre) laisserait la
    // main fermée sur toute l'application.
    inject(DestroyRef).onDestroy(() => document.body.classList.remove('is-dock-dragging'));
  }
  private readonly sessionRegistry = inject(SessionRegistry);

  private readonly contextMenu = inject(ContextMenuService);

  /** Transferts actifs de TOUTES les sessions : le badge de l'onglet ne doit
   *  pas retomber à zéro parce qu'on a focalisé l'autre serveur. */
  private activeTransfers(): number {
    return this.sessionRegistry.sessions().reduce((total, session) => total + session.transfers.activeCount(), 0);
  }

  readonly node = input.required<DockNode>();

  protected readonly split = computed<DockSplit | null>(() => {
    const n = this.node();
    return n.kind === 'split' ? n : null;
  });

  protected readonly groupNode = computed<DockGroup | null>(() => {
    const n = this.node();
    return n.kind === 'group' ? n : null;
  });

  /** Zone de dépôt à surligner si ce groupe est la cible courante. */
  protected readonly dropZone = computed<DockZone | null>(() => {
    const n = this.node();
    const target = this.dock.dropTarget();
    return n.kind === 'group' && target?.groupId === n.id ? target.zone : null;
  });

  protected readonly meta = PANEL_META;

  /**
   * La croix ne s'affiche que s'il reste de quoi fermer : le DERNIER panneau
   * ouvert est protégé par le service, et proposer un geste sans effet serait
   * mentir. Le panneau serveur, lui, n'est plus une exception.
   */
  protected readonly canClose = computed(() => this.dock.openPanels().size > 1);

  /** Ce groupe se fermerait si la poignée était relâchée maintenant. */
  protected willClose(node: DockGroup): boolean {
    const doomed = this.dock.nearCollapse();
    return doomed.size > 0 && node.panels.every((panel) => doomed.has(panel));
  }

  protected tabLabel(panel: DockPanelId): string {
    if (panel === 'transfers') {
      const active = this.activeTransfers();
      return active > 0 ? `Transferts · ${active}` : 'Transferts';
    }
    return PANEL_META[panel].label;
  }

  /** Active un onglet et le ramène en vue (la bande peut défiler). */
  protected onTabClick(event: Event, node: DockGroup, panel: DockPanelId): void {
    this.dock.activate(node.id, panel);
    (event.currentTarget as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Clic droit sur la barre d'onglets : fermer / rouvrir / réinitialiser. */
  protected openTabMenu(event: MouseEvent, node: DockGroup, panel: DockPanelId): void {
    const items: ContextMenuItem[] = [];
    // Le panneau serveur se ferme comme les autres ; seul le DERNIER panneau
    // ouvert reste protégé, et l'entrée disparaît alors du menu plutôt que
    // d'y rester sans effet.
    if (this.canClose()) {
      items.push({
        label: `Fermer « ${PANEL_META[panel].label} »`,
        icon: 'close',
        action: () => this.dock.closePanel(panel),
      });
    }
    for (const closed of this.dock.closedPanels()) {
      items.push({
        label: `Rouvrir : ${PANEL_META[closed].label}`,
        icon: PANEL_META[closed].icon,
        action: () => this.dock.openPanel(closed),
      });
    }
    items.push({
      label: 'Réinitialiser la disposition',
      icon: 'layout-grid',
      action: () => this.dock.reset(),
    });
    this.contextMenu.open(event, items);
  }

  // --- Redimensionnement entre enfants d'un split ---

  private resizeCtx: { splitId: string; index: number; sizes: number[]; px: number } | null = null;

  protected beginResize(node: DockSplit, index: number, container: HTMLElement): void {
    this.dock.resizing.set(true);
    this.resizeCtx = {
      splitId: node.id,
      index,
      sizes: [...node.sizes],
      px: node.dir === 'row' ? container.clientWidth : container.clientHeight,
    };
  }

  protected onResize(delta: number): void {
    const ctx = this.resizeCtx;
    if (ctx && ctx.px > 0) {
      this.dock.resizeSplit(ctx.splitId, ctx.index, ctx.sizes, delta / ctx.px, ctx.px);
    }
  }

  protected endResize(): void {
    this.dock.resizing.set(false);
    // Poignée tirée jusqu'au bord : le panneau devenu minuscule se ferme,
    // plutôt que de rester en bande où son contenu se chevauche.
    const ctx = this.resizeCtx;
    if (ctx) {
      this.dock.collapseIfTiny(ctx.splitId, ctx.px);
    }
    this.resizeCtx = null;
  }

  // --- Glissement du panneau actif via la poignée (grip) ---

  private pending: { panel: DockPanelId; groupId: string; x: number; y: number } | null = null;
  private draggingTab = false;
  /** Rects figés au début du drag (le layout ne bouge pas pendant) :
   *  hit-test purement géométrique : elementsFromPoint n'est pas fiable
   *  au-dessus des contenus scrollables dans WKWebView. */
  private dockRect: DOMRect | null = null;
  private groupRects: { id: string; rect: DOMRect }[] = [];
  private tabsRects: { id: string; rect: DOMRect }[] = [];

  protected onTabPointerDown(event: PointerEvent, node: DockGroup, panel: DockPanelId): void {
    if (event.button !== 0) {
      return;
    }
    this.pending = { panel, groupId: node.id, x: event.clientX, y: event.clientY };
    this.draggingTab = false;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected onTabPointerMove(event: PointerEvent): void {
    if (!this.pending) {
      return;
    }
    if (!this.draggingTab) {
      const distance = Math.hypot(event.clientX - this.pending.x, event.clientY - this.pending.y);
      if (distance < DRAG_THRESHOLD) {
        return;
      }
      this.draggingTab = true;
      document.body.classList.add('is-dock-dragging');
      this.dockRect = document.querySelector('app-dock')?.getBoundingClientRect() ?? null;
      this.groupRects = Array.from(document.querySelectorAll<HTMLElement>('[data-dock-group]')).map((el) => ({
        id: el.getAttribute('data-dock-group')!,
        rect: el.getBoundingClientRect(),
      }));
      this.tabsRects = Array.from(document.querySelectorAll<HTMLElement>('[data-dock-tabs]')).map((el) => ({
        id: el.getAttribute('data-dock-tabs')!,
        rect: el.getBoundingClientRect(),
      }));
      this.dock.beginDrag(this.pending.panel, this.pending.groupId, event.clientX, event.clientY);
    }
    this.dock.updateDrag(event.clientX, event.clientY);
    this.hitTest(event.clientX, event.clientY);
  }

  protected onTabPointerUp(): void {
    const wasDragging = this.draggingTab;
    this.pending = null;
    this.draggingTab = false;
    document.body.classList.remove('is-dock-dragging');
    if (wasDragging) {
      this.dock.endDrag(true);
    }
  }

  protected onTabPointerCancel(): void {
    this.pending = null;
    this.draggingTab = false;
    document.body.classList.remove('is-dock-dragging');
    this.dock.endDrag(false);
  }

  /** Bande (px) des bords de l'espace de travail = dépôt au niveau racine.
   *  Fine : les barres d'onglets (empilement) restent visables au-dessous. */
  private static readonly ROOT_EDGE = 12;

  /** Trouve la cible sous le curseur : bord de fenêtre → barre d'onglets
   *  (= empilement) → zones du groupe. */
  private hitTest(x: number, y: number): void {
    // 1. Fine bande sur les bords du dock : le panneau prendra ce côté entier
    //    (tolérance vers l'extérieur : léger dépassement sur la toolbar/statut).
    const rect = this.dockRect;
    if (rect) {
      const m = DockNodeView.ROOT_EDGE;
      const inside = x >= rect.left - 16 && x <= rect.right + 16 && y >= rect.top - 16 && y <= rect.bottom + 16;
      if (inside) {
        const zone: DockZone | null =
          x - rect.left < m
            ? 'left'
            : rect.right - x < m
              ? 'right'
              : y - rect.top < m
                ? 'top'
                : rect.bottom - y < m
                  ? 'bottom'
                  : null;
        if (zone) {
          this.dock.dropTarget.set({ groupId: ROOT_TARGET, zone });
          return;
        }
      }
    }

    const contains = (r: DOMRect): boolean => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

    // 2. Sur une barre d'onglets : empilement direct (le geste naturel,
    //    comme déposer un onglet de navigateur à côté des autres).
    const tabsBar = this.tabsRects.find((t) => contains(t.rect));
    if (tabsBar) {
      this.dock.dropTarget.set({ groupId: tabsBar.id, zone: 'center' });
      return;
    }

    // 3. Sinon : zone du groupe survolé (centre = onglet, bord = split).
    //    Les groupes tuilent l'espace sans chevauchement : premier rect gagnant.
    const hit = this.groupRects.find((g) => contains(g.rect));
    if (!hit) {
      this.dock.dropTarget.set(null);
      return;
    }
    const groupRect = hit.rect;
    const rx = (x - groupRect.left) / groupRect.width;
    const ry = (y - groupRect.top) / groupRect.height;
    // Zone au bord le plus proche (distances normalisées) : les 4 côtés
    // restent visables même sur un groupe très large et plat (ou l'inverse).
    let zone: DockZone;
    if (rx >= 0.25 && rx <= 0.75 && ry >= 0.25 && ry <= 0.75) {
      zone = 'center';
    } else {
      const nearest = Math.min(rx, 1 - rx, ry, 1 - ry);
      zone = nearest === rx ? 'left' : nearest === 1 - rx ? 'right' : nearest === ry ? 'top' : 'bottom';
    }
    this.dock.dropTarget.set({ groupId: hit.id, zone });
  }
}
