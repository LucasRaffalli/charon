import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';

/**
 * Ce qui apparaît sous une liste quand plusieurs éléments sont sélectionnés :
 * le compte, et ce qu'on peut faire du lot.
 *
 * Purement présentationnel — l'état vit dans le navigateur de fichiers, les
 * actions ressortent en événements.
 */
@Component({
  selector: 'app-selection-bar',
  imports: [Icon],
  template: `
    <span class="selbar__count">
      {{ count() }} sélectionné{{ count() > 1 ? 's' : '' }}
    </span>
    <button type="button" class="selbar__clear" (click)="clear.emit()">Désélectionner</button>
    <span class="selbar__spacer"></span>
    @if (fileCount() > 0) {
      <button type="button" class="selbar__act" (click)="download.emit()">
        <app-icon name="download" [size]="13" />
        Télécharger{{ partial() ? ' les fichiers' : '' }}
      </button>
    }
    @if (writable()) {
      <button type="button" class="selbar__act" (click)="copy.emit()">
        <app-icon name="copy" [size]="13" />
        Copier
      </button>
      <button type="button" class="selbar__act selbar__act--danger" (click)="remove.emit()">
        <app-icon name="trash" [size]="13" />
        Supprimer
      </button>
    }
  `,
  styleUrl: './selection-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectionBar {
  readonly count = input.required<number>();
  /** Combien de fichiers : les dossiers ne se téléchargent pas. */
  readonly fileCount = input.required<number>();
  readonly writable = input(true);

  /** Le lot mêle fichiers et dossiers : le bouton le dit. */
  protected readonly partial = computed(() => this.fileCount() < this.count());

  readonly clear = output<void>();
  readonly download = output<void>();
  readonly copy = output<void>();
  readonly remove = output<void>();
}
