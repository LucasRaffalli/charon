import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { IconName } from '@app/components/ui/icon/icon';
import { ToolButton } from '@app/components/ui/tool-button/tool-button';
import { injectT } from '@app/lang/i18n.service';

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
      {{ t(count() > 1 ? 'panes.selection.many' : 'panes.selection.one', { count: count() }) }}
    </span>
    <span class="selbar__spacer"></span>
    @if (fileCount() > 0) {
      <app-tool-button
        [icon]="actionIcon()"
        [label]="actionText() + (partial() ? t('panes.selection.filesSuffix') : '')"
        (pressed)="action.emit()"
      />
    }
    @if (writable()) {
      <app-tool-button icon="copy" [label]="copyText()" (pressed)="copy.emit()" />
      <app-tool-button
        icon="trash"
        [label]="t('common.buttons.delete')"
        [danger]="true"
        (pressed)="remove.emit()"
      />
    }
    <app-tool-button
      icon="close"
      [label]="t('panes.selection.deselect')"
      (pressed)="clear.emit()"
    />
  `,
  styleUrl: './selection-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectionBar {
  protected readonly t = injectT();
  readonly count = input.required<number>();
  /** Combien de fichiers : les dossiers ne se transfèrent pas. */
  readonly fileCount = input.required<number>();
  readonly writable = input(true);

  /**
   * Le transfert n'a pas le même sens des deux côtés : le serveur télécharge,
   * le disque local envoie. Le reste de la barre ne change pas.
   */
  readonly actionIcon = input<IconName>('download');
  /**
   * Libellés laissés VIDES par défaut, résolus plus bas dans un computed.
   * Une valeur par défaut prise au dictionnaire à la construction serait figée
   * dans la langue du démarrage : le composant ne se retraduirait jamais.
   */
  readonly actionLabel = input('');
  readonly copyLabel = input('');

  protected readonly actionText = computed(
    () => this.actionLabel() || this.t('common.buttons.download'),
  );
  protected readonly copyText = computed(() => this.copyLabel() || this.t('common.buttons.copy'));

  /** Le lot mêle fichiers et dossiers : le bouton le dit. */
  protected readonly partial = computed(() => this.fileCount() < this.count());

  readonly clear = output<void>();
  readonly action = output<void>();
  readonly copy = output<void>();
  readonly remove = output<void>();
}
