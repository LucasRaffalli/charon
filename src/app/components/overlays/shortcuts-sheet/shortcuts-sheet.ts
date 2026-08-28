import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ShortcutsList } from '@app/components/panels/shortcuts-list/shortcuts-list';
import { ShortcutsService } from '@app/services/workspace/shortcuts.service';

/**
 * La liste des raccourcis (⌘/), lue directement du registre : elle ne peut
 * pas mentir ni prendre du retard, puisque c'est la même source que ce qui
 * s'exécute.
 */
@Component({
  selector: 'app-shortcuts-sheet',
  imports: [ShortcutsList],
  template: `
    @if (shortcuts.listOpen()) {
      <div class="scrim" (click)="shortcuts.listOpen.set(false)">
        <div
          class="sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Raccourcis clavier"
          (click)="$event.stopPropagation()"
        >
          <header class="sheet__head">
            <span class="sheet__title">Raccourcis</span>
            <span class="sheet__hint">Tout ce que Charon écoute au clavier</span>
          </header>
          <div class="sheet__body">
            <app-shortcuts-list />
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './shortcuts-sheet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShortcutsSheet {
  protected readonly shortcuts = inject(ShortcutsService);
}
