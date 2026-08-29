import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { ToolButton } from '@app/components/ui/tool-button/tool-button';

/**
 * Ce qui apparaît sous une liste quand plusieurs éléments sont sélectionnés :
 * le compte, et ce qu'on peut faire du lot.
 *
 * Purement présentationnel — l'état vit dans le navigateur de fichiers, les
 * actions ressortent en événements.
 */
@Component({
  selector: 'app-selection-bar',
  imports: [ToolButton],
  template: `
    <span class="selbar__count">
      {{ count() }} sélectionné{{ count() > 1 ? 's' : '' }}
    </span>
    <span class="selbar__spacer"></span>
    @if (fileCount() > 0) {
      <app-tool-button
        icon="download"
        [label]="'Télécharger' + (partial() ? ' les fichiers' : '')"
        (pressed)="download.emit()"
      />
    }
    @if (writable()) {
      <app-tool-button icon="copy" label="Copier" (pressed)="copy.emit()" />
      <app-tool-button icon="trash" label="Supprimer" [danger]="true" (pressed)="remove.emit()" />
    }
    <app-tool-button icon="close" label="Désélectionner" (pressed)="clear.emit()" />
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
