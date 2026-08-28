import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ShortcutsService, shortcutSymbols } from '@app/services/workspace/shortcuts.service';

/**
 * La liste des raccourcis, sans habillage.
 *
 * Extraite pour servir aux deux endroits qui la montrent : la feuille ⌘/ et
 * l'onglet des réglages. Une seule source, donc aucun risque qu'une des deux
 * prenne du retard sur le registre.
 */
@Component({
  selector: 'app-shortcuts-list',
  template: `
    @for (group of shortcuts.grouped(); track group.group) {
      <section class="grp">
        <h3 class="grp__name">{{ group.group }}</h3>
        @for (item of group.items; track item.keys + item.label) {
          <div class="grp__row">
            <span class="grp__keys">
              @for (symbol of symbols(item.keys); track $index) {
                <kbd>{{ symbol }}</kbd>
              }
            </span>
            <span class="grp__label">{{ item.label }}</span>
          </div>
        }
      </section>
    } @empty {
      <p class="empty">Aucun raccourci dans ce contexte.</p>
    }
  `,
  styleUrl: './shortcuts-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShortcutsList {
  protected readonly shortcuts = inject(ShortcutsService);

  /** macOS parle en ⌘ et ⌥, le reste en Ctrl et Alt. */
  private readonly mac = /mac/i.test(navigator.platform || navigator.userAgent);

  protected symbols(keys: string): string[] {
    return shortcutSymbols(keys, this.mac);
  }
}
