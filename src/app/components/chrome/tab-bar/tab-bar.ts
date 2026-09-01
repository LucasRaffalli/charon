import { DOCUMENT } from '@angular/core';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { ContextMenuService } from '@app/services/workspace/context-menu.service';
import { TabBarService, TabItem, TabSegment } from '@app/services/workspace/tab-bar.service';
import { injectT } from '@app/lang/i18n.service';

/** Au-delà de ce déplacement, c'est un glissé et plus un clic. Même seuil que
 *  partout ailleurs dans l'application. */
const DRAG_THRESHOLD = 5;

/**
 * La barre d'onglets. Un onglet est une SESSION dans la page (flotte v2), et
 * les deux sessions de la vue double fusionnent en UN onglet à segments :
 * l'onglet dit ce que la surface montre. La barre sert aussi de zone de
 * saisie de la fenêtre (`data-tauri-drag-region` sur le fond seulement).
 */
@Component({
  selector: 'app-tab-bar',
  imports: [Icon],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabBar {
  private readonly t = injectT();
  protected readonly tabBar = inject(TabBarService);
  private readonly registry = inject(SessionRegistry);
  private readonly contextMenu = inject(ContextMenuService);
  private readonly destroyRef = inject(DestroyRef);

  protected trackOf(tab: TabItem): string {
    return tab.kind === 'single' ? tab.segment.id : 'pair';
  }

  // --- Réordonner les onglets ------------------------------------------------
  //
  // En événements POINTEUR, comme le glissé de fichiers et celui du dock : le
  // drag HTML5 ne fonctionne pas dans la webview (le handler natif de Tauri
  // avale `dragover`/`drop`). Le seuil de 5 px protège le clic, et l'onglet
  // suivi ne bouge pas lui-même : c'est un TRAIT qui dit où il se posera, ce
  // qui évite de faire sauter la barre sous le curseur.

  /** L'onglet saisi, tant que le seuil n'est pas franchi. */
  private pending: { id: string; x: number } | null = null;
  /** Le rang d'insertion visé, ou `null` hors glissé. */
  protected readonly insertAt = signal<number | null>(null);
  private dragging: string | null = null;

  protected onTabPointerDown(event: PointerEvent, id: string): void {
    if (event.button !== 0) {
      return;
    }
    this.pending = { id, x: event.clientX };
    this.document.addEventListener('pointermove', this.onPointerMove);
    this.document.addEventListener('pointerup', this.onPointerUp, { once: true });
    this.document.addEventListener('pointercancel', this.onPointerUp, { once: true });
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    if (!this.dragging) {
      if (Math.abs(event.clientX - pending.x) < DRAG_THRESHOLD) {
        return;
      }
      this.dragging = pending.id;
      this.document.body.classList.add('is-dock-dragging');
    }
    this.insertAt.set(this.indexAt(event.clientX));
  };

  private readonly onPointerUp = (): void => {
    const dragged = this.dragging;
    const index = this.insertAt();
    this.stopDrag();
    if (dragged && index !== null) {
      this.registry.reorder(dragged, index);
    }
  };

  private stopDrag(): void {
    this.pending = null;
    this.dragging = null;
    this.insertAt.set(null);
    this.document.body.classList.remove('is-dock-dragging');
    this.document.removeEventListener('pointermove', this.onPointerMove);
    this.document.removeEventListener('pointerup', this.onPointerUp);
    this.document.removeEventListener('pointercancel', this.onPointerUp);
  }

  /**
   * Le rang sous le curseur, exprimé dans la liste des SESSIONS.
   *
   * Ce n'est pas le rang de l'onglet : un onglet fusionné vaut deux sessions,
   * et confondre les deux décale tout dès qu'une vue double est posée. Chaque
   * vignette porte donc l'identifiant de sa PREMIÈRE session, et c'est sa
   * position dans le registre qui fait foi.
   *
   * On compare au MILIEU de chaque onglet : la vignette pousse son voisin dès
   * qu'on l'a dépassé à moitié.
   */
  private indexAt(x: number): number {
    const sessions = this.registry.sessions();
    const tabs = Array.from(this.document.querySelectorAll<HTMLElement>('.bar [data-tab-first]'));
    for (const tab of tabs) {
      const rect = tab.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) {
        const at = sessions.findIndex((session) => session.id === tab.dataset['tabFirst']);
        return at === -1 ? sessions.length : at;
      }
    }
    return sessions.length;
  }

  /** Le trait se dessine-t-il devant cet onglet ? (rang de session, pas d'onglet) */
  protected insertBefore(tab: TabItem): boolean {
    const at = this.insertAt();
    if (at === null) {
      return false;
    }
    const first = tab.kind === 'single' ? tab.segment.id : tab.segments[0].id;
    return this.registry.sessions()[at]?.id === first;
  }

  /** Le trait se dessine-t-il en bout de barre ? */
  protected insertAtEnd(): boolean {
    return this.insertAt() === this.registry.sessions().length;
  }

  private readonly document = inject(DOCUMENT);

  constructor() {
    // Un onglet détruit en plein glissé (session fermée depuis une autre
    // surface) laisserait ses écouteurs et la main fermée sur toute l'app.
    this.destroyRef.onDestroy(() => this.stopDrag());
  }

  protected close(event: MouseEvent, id: string): void {
    // Le clic de fermeture ne doit pas aussi activer l'onglet.
    event.stopPropagation();
    void this.tabBar.closeSession(id);
  }

  /** Clic molette = fermer, comme dans un navigateur. */
  protected onAuxClick(event: MouseEvent, id: string): void {
    if (event.button === 1) {
      void this.tabBar.closeSession(id);
    }
  }

  /**
   * Clic droit sur un onglet simple : la vue double se pose ici, avec
   * n'importe quelle autre session embarquée : le focus du moment n'a pas
   * voix au chapitre. L'autre session passe à gauche (elle est déjà là),
   * celle qu'on vient de saisir à droite.
   */
  protected onTabMenu(event: MouseEvent, segment: TabSegment): void {
    const items = [];
    for (const other of this.tabBar.splitCandidatesFor(segment.id)) {
      items.push({
        label: this.t('misc.tabs.splitWith', { name: this.tabBar.titleOf(other) }),
        icon: 'columns' as const,
        action: () => this.tabBar.split(other.id, segment.id),
      });
    }
    items.push({
      label: this.t('shortcuts.closeTab'),
      icon: 'close' as const,
      action: () => void this.tabBar.closeSession(segment.id),
    });
    this.contextMenu.open(event, items);
  }

  /** Clic droit sur un segment de l'onglet fusionné. */
  protected onSegmentMenu(event: MouseEvent, segment: TabSegment): void {
    this.contextMenu.open(event, [
      {
        label: this.t('misc.tabs.unsplit'),
        icon: 'columns',
        action: () => this.tabBar.unsplit(),
      },
      {
        label: this.t('shortcuts.closeTab'),
        icon: 'close',
        action: () => void this.tabBar.closeSession(segment.id),
      },
    ]);
  }
}
