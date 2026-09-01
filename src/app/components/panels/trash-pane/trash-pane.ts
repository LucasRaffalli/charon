import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { SftpService } from '@app/services/connection/sftp.service';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { fileIconFor } from '@app/services/files/file-icon';
import { TrashEntry, TrashService } from '@app/services/files/trash.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { injectT } from '@app/lang/i18n.service';

/**
 * Le panneau Corbeille : ce qui a été jeté dans le dossier affiché, et de quoi
 * le récupérer.
 *
 * Il suit le dossier courant, parce que la corbeille vit **par point de
 * montage** (`<parent>/.charon-trash/`) : il n'y a pas de corbeille unique à
 * montrer, il y a celle de l'endroit où l'on se trouve.
 */
@Component({
  selector: 'app-trash-pane',
  imports: [Icon, FileSizePipe],
  templateUrl: './trash-pane.html',
  styleUrl: './trash-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashPane {
  protected readonly t = injectT();
  private readonly sessionRegistry = inject(SessionRegistry);

  protected get sftp(): SftpService {
    return this.sessionRegistry.focused().sftp;
  }
  private get trash(): TrashService {
    return this.sessionRegistry.focused().trash;
  }
  private readonly dialog = inject(DialogService);

  protected readonly entries = signal<TrashEntry[]>([]);
  protected readonly loading = signal(false);
  /** Le dossier dont on montre la corbeille, figé au moment de la lecture. */
  protected readonly dir = signal('/');

  constructor() {
    // Suit le dossier de l'explorateur (c'est celui dont la corbeille compte)
    // ET le compteur du service : sans lui, jeter un fichier ne rechargeait
    // rien, puisque le dossier affiché, lui, n'avait pas changé.
    effect(() => {
      const path = this.sftp.currentPath();
      const connected = this.sftp.connected();
      this.trash.version();
      if (connected) {
        void this.load(path);
      } else {
        this.entries.set([]);
      }
    });
  }

  protected async load(path = this.sftp.currentPath()): Promise<void> {
    this.loading.set(true);
    this.dir.set(path);
    this.entries.set(await this.trash.list(path));
    this.loading.set(false);
  }

  protected iconFor(entry: TrashEntry): ReturnType<typeof fileIconFor> {
    return entry.isDir ? 'folder' : fileIconFor(entry.name);
  }

  /** La date de mise à la corbeille, ou rien si le nom ne la portait pas. */
  protected when(entry: TrashEntry): string {
    if (!entry.at) {
      return 'date inconnue';
    }
    const days = Math.floor((Date.now() / 1000 - entry.at) / 86400);
    if (days <= 0) {
      return "aujourd'hui";
    }
    return days === 1 ? 'hier' : `il y a ${days} jours`;
  }

  protected async restore(entry: TrashEntry): Promise<void> {
    if (await this.trash.restore(entry, this.dir())) {
      await this.load(this.dir());
    }
  }

  protected async destroy(entry: TrashEntry): Promise<void> {
    const confirmed = await this.dialog.confirm({
      title: this.t('trashPane.deleteTitle', { name: entry.name }),
      message: this.t('trashPane.deleteMessage'),
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (confirmed) {
      await this.trash.destroy(entry);
      await this.load(this.dir());
      await this.sftp.refresh();
    }
  }

  protected async empty(): Promise<void> {
    const count = this.entries().length;
    const confirmed = await this.dialog.confirm({
      title: this.t('trashPane.emptyTitle'),
      message: `${count} élément${count > 1 ? 's' : ''} ${count > 1 ? 'seront supprimés' : 'sera supprimé'} définitivement.`,
      confirmLabel: 'Vider',
      danger: true,
    });
    if (confirmed) {
      await this.trash.empty(this.dir());
      await this.load(this.dir());
    }
  }
}
