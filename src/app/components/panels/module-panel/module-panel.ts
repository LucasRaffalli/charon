import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { ModuleStat } from '@app/interfaces';
import { ModuleHostService } from '@app/services/module-host.service';

/**
 * Rendu natif des vues déclaratives émises par les modules (`charon.ui.render`).
 * Un module ne dessine jamais de HTML : il fournit une structure
 * (sections / stats / tables) que ce composant affiche. Aucune injection
 * possible — les chaînes sont interpolées, jamais évaluées.
 *
 * Chaque vue de module est **repliable** (clic sur son en-tête) pour dégager
 * de la place quand plusieurs modules affichent un panneau.
 */
@Component({
  selector: 'app-module-panel',
  imports: [Icon],
  templateUrl: './module-panel.html',
  styleUrl: './module-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModulePanel {
  protected readonly host = inject(ModuleHostService);

  /** Ids de panneaux repliés (par `panelId`). */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected isCollapsed(panelId: string): boolean {
    return this.collapsed().has(panelId);
  }

  protected toggle(panelId: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      next.has(panelId) ? next.delete(panelId) : next.add(panelId);
      return next;
    });
  }

  /** Largeur de jauge bornée 0–100 %. */
  protected gauge(stat: ModuleStat): number {
    const r = stat.ratio ?? 0;
    return Math.max(0, Math.min(100, Math.round(r * 100)));
  }
}
