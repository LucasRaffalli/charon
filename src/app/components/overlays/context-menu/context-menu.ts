import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import {
  ContextMenuItem,
  ContextMenuService,
  ContextMenuState,
} from '@app/services/context-menu.service';

const MENU_WIDTH = 210;
const ITEM_HEIGHT = 32;

/** Rendu du menu contextuel global. À placer une seule fois, à la racine. */
@Component({
  selector: 'app-context-menu',
  imports: [Icon],
  templateUrl: './context-menu.html',
  styleUrl: './context-menu.scss',
  host: {
    '(document:keydown.escape)': 'menu.close()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextMenu {
  protected readonly menu = inject(ContextMenuService);

  protected run(item: ContextMenuItem): void {
    this.menu.close();
    item.action?.();
  }

  protected x(state: ContextMenuState): number {
    return Math.max(0, Math.min(state.x, window.innerWidth - MENU_WIDTH - 8));
  }

  protected y(state: ContextMenuState): number {
    const height = state.items.length * ITEM_HEIGHT + 12;
    return Math.max(0, Math.min(state.y, window.innerHeight - height - 8));
  }
}
