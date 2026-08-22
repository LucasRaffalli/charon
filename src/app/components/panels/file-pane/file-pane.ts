import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  output,
} from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';
import { FileEntry } from '@app/interfaces';

/**
 * Panneau de navigation compact dans un système de fichiers.
 * Purement présentationnel : l'état vient des inputs, les actions sortent en outputs.
 */
@Component({
  selector: 'app-file-pane',
  imports: [Icon],
  templateUrl: './file-pane.html',
  styleUrl: './file-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilePane {
  readonly title = input.required<string>();
  readonly icon = input.required<IconName>();
  readonly path = input.required<string>();
  readonly entries = input.required<FileEntry[]>();
  readonly loading = input(false);
  readonly atRoot = input(false);
  readonly error = input<string | null>(null);
  /** N'affiche que les dossiers (navigation pure). */
  readonly dirsOnly = input(false, { transform: booleanAttribute });
  /** Action proposée sur les fichiers (icône affichée au survol). */
  readonly actionIcon = input<IconName | null>(null);
  readonly actionLabel = input('');

  readonly openDir = output<FileEntry>();
  readonly navigateUp = output<void>();
  readonly fileAction = output<FileEntry>();
  /** Clic droit sur une entrée. */
  readonly entryMenu = output<{ event: MouseEvent; entry: FileEntry }>();
  /** Clic droit sur le fond de la liste. */
  readonly areaMenu = output<MouseEvent>();

  protected readonly visibleEntries = computed(() =>
    this.dirsOnly() ? this.entries().filter((entry) => entry.isDir) : this.entries(),
  );
}
