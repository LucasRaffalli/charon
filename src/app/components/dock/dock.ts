import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
} from '@angular/core';

import { DockNodeView } from '@app/components/dock/dock-node';
import { Icon, IconName } from '@app/components/ui/icon/icon';
import { DockZone } from '@app/interfaces';
import { DockService, PANEL_META, ROOT_TARGET } from '@app/services/dock.service';

/**
 * Racine du dock : rend l'arbre (splits + groupes), affiche le fantôme
 * pendant un glissement d'onglet, et surtout **place les panneaux** : les
 * contenus vivent dans un hangar caché ([data-dock-panel] côté explorateur)
 * et sont déplacés dans les slots des groupes après chaque rendu : le DOM
 * n'est jamais détruit, l'état (terminal, logs, scroll…) survit aux
 * réagencements.
 */
@Component({
  selector: 'app-dock',
  imports: [DockNodeView, Icon],
  templateUrl: './dock.html',
  styleUrl: './dock.scss',
  host: {
    '[class.dock--dragging]': 'dock.drag() !== null',
    '[class.dock--resizing]': 'dock.resizing()',
    '(document:keydown.escape)': 'cancelDrag()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dock {
  protected readonly dock = inject(DockService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly ghostIcon = computed<IconName>(
    () => PANEL_META[this.dock.drag()?.panel ?? 'local'].icon,
  );
  protected readonly ghostLabel = computed(() => {
    const panel = this.dock.drag()?.panel;
    return panel ? PANEL_META[panel].label : '';
  });

  /** Zone de bord de fenêtre survolée (dépôt au niveau racine). */
  protected readonly rootZone = computed<DockZone | null>(() => {
    const target = this.dock.dropTarget();
    return target?.groupId === ROOT_TARGET ? target.zone : null;
  });

  constructor() {
    // Replacer les panneaux après un rendu où la STRUCTURE a changé
    // (le resize et l'activation d'onglet ne déplacent rien).
    afterRenderEffect(() => {
      this.dock.structure();
      this.placePanels();
    });
  }

  protected cancelDrag(): void {
    if (this.dock.drag()) {
      this.dock.endDrag(false);
    }
  }

  /**
   * Références des éléments de panneau, capturées au premier placement.
   * Indispensable : quand une mutation de l'arbre détruit un slot, le
   * panneau qu'il contenait est DÉTACHÉ du document : document.querySelector
   * ne le trouverait plus, mais la référence reste valide et appendChild
   * le raccroche.
   */
  private readonly panelElements = new Map<string, HTMLElement>();

  private panelElement(panel: string): HTMLElement | null {
    const cached = this.panelElements.get(panel);
    if (cached) {
      return cached;
    }
    const found = document.querySelector<HTMLElement>(`[data-dock-panel="${panel}"]`);
    if (found) {
      this.panelElements.set(panel, found);
    }
    return found;
  }

  /** Déplace chaque panneau du hangar vers le slot de son groupe. */
  private placePanels(): void {
    const root = this.host.nativeElement;
    const hangar = document.querySelector('[data-dock-hangar]');
    const placed = new Set<string>();

    const slots = new Map<string, Element>();
    root.querySelectorAll('[data-dock-slot]').forEach((el) => {
      slots.set(el.getAttribute('data-dock-slot') ?? '', el);
    });

    for (const group of this.dock.groups()) {
      const slot = slots.get(group.id);
      if (!slot) {
        continue;
      }
      for (const panel of group.panels) {
        const element = this.panelElement(panel);
        if (!element) {
          continue;
        }
        placed.add(panel);
        if (element.parentElement !== slot) {
          slot.appendChild(element);
        }
        // Le masquage (onglet inactif) est un binding [hidden] réactif côté
        // explorateur : appliqué au rendu, jamais ici.
      }
    }

    // Panneau absent de l'arbre (ne devrait pas arriver) : retour au hangar.
    for (const [panelId, element] of this.panelElements) {
      if (!placed.has(panelId) && hangar && element.parentElement !== hangar) {
        hangar.appendChild(element);
      }
    }
  }
}
