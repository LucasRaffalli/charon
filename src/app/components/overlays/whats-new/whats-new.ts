import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { ChangeKind } from '@app/interfaces';
import { WhatsNewService } from '@app/services/system/whats-new.service';

/**
 * Compare deux versions sémantiques. `localeCompare` dirait que 1.10 précède
 * 1.9, ce qui est faux dès qu'on dépasse la neuvième version mineure.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

const KIND_LABELS: Record<ChangeKind, string> = {
  new: 'Nouveau',
  better: 'Amélioré',
  fixed: 'Corrigé',
};

/**
 * Les nouveautés en grand : le même carnet de bord que les réglages, mais
 * lisible d'un coup, et ouvert au moment où il sert.
 */
@Component({
  selector: 'app-whats-new',
  imports: [Button],
  templateUrl: './whats-new.html',
  styleUrl: './whats-new.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WhatsNew {
  protected readonly whatsNew = inject(WhatsNewService);
  protected readonly kindLabels = KIND_LABELS;

  /**
   * L'ordre du journal, du plus récent au plus ancien — celui du fichier.
   *
   * La version installée est **marquée, pas remontée** : la faire passer en
   * tête mettait 1.1.1 au-dessus de 1.2.0, ce qui n'est plus un journal. Le
   * repère se déplace, l'ordre non.
   */
  protected readonly entries = computed(() => this.whatsNew.entries);

  /** Ce que porte le badge d'une version, ou rien. */
  protected badge(version: string): string | null {
    const installed = this.whatsNew.highlighted();
    if (!installed) {
      return null;
    }
    if (version === installed) {
      return 'installée';
    }
    // Au-dessus de l'installée : livré, mais pas encore chez cet utilisateur.
    return compareVersions(version, installed) > 0 ? 'après mise à jour' : null;
  }

  protected isHighlighted(version: string): boolean {
    return version === this.whatsNew.highlighted();
  }

  /**
   * Le mode d'emploi déplié, par note.
   *
   * À la demande : une liste où chaque ligne porterait son paragraphe
   * d'explication ne se lirait plus comme un journal.
   */
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  protected isOpen(key: string): boolean {
    return this.opened().has(key);
  }

  protected toggleHow(key: string): void {
    this.opened.update((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }
}
