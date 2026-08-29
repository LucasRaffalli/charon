import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { ContextMenuService } from '@app/services/workspace/context-menu.service';
import { TabBarService, TabItem, TabSegment } from '@app/services/workspace/tab-bar.service';

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
  protected readonly tabBar = inject(TabBarService);
  private readonly contextMenu = inject(ContextMenuService);

  protected trackOf(tab: TabItem): string {
    return tab.kind === 'single' ? tab.segment.id : 'pair';
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
        label: `Côte à côte avec « ${this.tabBar.titleOf(other)} »`,
        icon: 'columns' as const,
        action: () => this.tabBar.split(other.id, segment.id),
      });
    }
    items.push({
      label: 'Fermer l’onglet',
      icon: 'close' as const,
      action: () => void this.tabBar.closeSession(segment.id),
    });
    this.contextMenu.open(event, items);
  }

  /** Clic droit sur un segment de l'onglet fusionné. */
  protected onSegmentMenu(event: MouseEvent, segment: TabSegment): void {
    this.contextMenu.open(event, [
      {
        label: 'Séparer les onglets',
        icon: 'columns',
        action: () => this.tabBar.unsplit(),
      },
      {
        label: 'Fermer cette session',
        icon: 'close',
        action: () => void this.tabBar.closeSession(segment.id),
      },
    ]);
  }
}
