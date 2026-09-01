import { Injectable, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { FileEntry } from '@app/interfaces';
import { SftpService } from '@app/services/connection/sftp.service';
import { injectSessionActivity } from '@app/services/workspace/activity-log.service';
import { SettingsService } from '@app/services/system/settings.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { injectT } from '@app/lang/i18n.service';

/** Ce que le backend rend d'une mise à la corbeille. */
interface Trashed {
  path: string;
  origin: string;
}

export interface TrashEntry {
  path: string;
  name: string;
  /** Epoch en secondes, 0 si le nom ne porte pas de date. */
  at: number;
  isDir: boolean;
  size: number;
}

/**
 * La corbeille distante (idée 02).
 *
 * Elle vit **par point de montage**, à côté de ce qu'on jette
 * (`<parent>/.charon-trash/`) : un `rename` ne franchit pas les systèmes de
 * fichiers, et une corbeille unique dans le home échouerait dès qu'on
 * supprime dans `/var` sur une machine à plusieurs partitions.
 *
 * La purge se fait **par âge, à la connexion** : à la déconnexion on perdrait
 * le filet entre deux sessions, et jamais laisserait une corbeille grossir
 * sans fin sur un serveur qui n'a pas la place.
 */
@Injectable({ providedIn: 'root' })
export class TrashService {
  private readonly t = injectT();
  private readonly sftp = inject(SftpService);
  private readonly toasts = inject(ToastService);
  private readonly activity = injectSessionActivity();
  private readonly settings = inject(SettingsService);

  /** Le dernier lot jeté, pour l'annulation immédiate. */
  private readonly lastBatch = signal<Trashed[]>([]);

  /**
   * Incrémenté à chaque opération qui change le CONTENU de la corbeille.
   * Le panneau s'y abonne pour se recharger : sans ça, il ne suivait que le
   * dossier affiché, donc jeter un fichier ne le réveillait pas.
   */
  private readonly _version = signal(0);
  readonly version = this._version.asReadonly();

  private touched(): void {
    this._version.update((n) => n + 1);
  }

  constructor() {
    // La corbeille elle-même est un dossier du serveur et survit à tout, mais
    // le lot d'annulation est une mémoire de session : le garder ferait viser
    // des chemins d'une autre connexion.
    effect(() => {
      if (!this.sftp.connected()) {
        this.lastBatch.set([]);
      }
    });
  }

  /** La corbeille est-elle disponible ? Elle repose sur un rename SFTP. */
  available(): boolean {
    return this.sftp.protocol() === 'sftp' && this.sftp.protection() !== 'readonly';
  }

  /**
   * Jette une sélection. Rend le nombre d'éléments effectivement déplacés.
   *
   * Aucune confirmation : c'est tout l'intérêt du filet. Ce qui exige une
   * confirmation, c'est la suppression définitive.
   */
  async trash(entries: FileEntry[]): Promise<number> {
    const done: Trashed[] = [];
    let failed = 0;

    for (const entry of entries) {
      const path = this.sftp.pathTo(entry.name);
      try {
        const result = await invoke<Trashed>('sftp_trash', {
          connectionId: this.sftp.connectionId(),
          path,
        });
        done.push(result);
        this.activity.log('remove', 'remote', path, 'mis à la corbeille');
      } catch (error) {
        failed++;
        this.activity.log('remove', 'remote', path, String(error), false);
      }
    }

    this.lastBatch.set(done);
    this.touched();
    await this.sftp.refresh();

    if (done.length) {
      const what =
        done.length === 1 ? `« ${entries[0].name} »` : this.t('trash.items', { count: done.length });
      this.toasts.success(this.t('trash.toTrash', { what }), {
        key: 'trash',
        // Plus long que le barème : il faut le temps de voir le bouton, de
        // décider, et de le viser. Le survol suspend de toute façon.
        life: 12000,
        action: { label: 'Annuler', run: () => void this.undo() },
      });
    }
    if (failed) {
      this.toasts.error(
        `${failed} élément${failed > 1 ? 's' : ''} n’${failed > 1 ? 'ont' : 'a'} pas pu être jeté${failed > 1 ? 's' : ''}`,
        { detail: this.t('trash.seeJournal') },
      );
    }
    return done.length;
  }

  /** Remet le dernier lot à sa place. */
  async undo(): Promise<void> {
    const batch = this.lastBatch();
    if (!batch.length) {
      return;
    }
    this.lastBatch.set([]);
    let restored = 0;
    for (const item of batch) {
      try {
        // Un rename ordinaire : la corbeille est un dossier comme un autre.
        await this.sftp.moveTo(item.path, item.origin);
        this.activity.log('rename', 'remote', item.origin, 'restauré de la corbeille');
        restored++;
      } catch (error) {
        this.activity.log('rename', 'remote', item.path, String(error), false);
      }
    }
    this.touched();
    await this.sftp.refresh();
    if (restored) {
      this.toasts.success(`${restored} élément${restored > 1 ? 's' : ''} restauré${restored > 1 ? 's' : ''}`);
    } else {
      this.toasts.error('Rien n’a pu être restauré', {
        detail: this.t('trash.originGone'),
      });
    }
  }

  /** Le contenu de la corbeille d'un dossier, du plus récent au plus ancien. */
  async list(dir: string): Promise<TrashEntry[]> {
    if (this.sftp.protocol() !== 'sftp') {
      return [];
    }
    const entries = await invoke<TrashEntry[]>('sftp_trash_list', {
      connectionId: this.sftp.connectionId(),
      dir,
    }).catch(() => []);
    return entries.sort((a, b) => b.at - a.at);
  }

  /**
   * Remet une entrée à sa place : le parent de la corbeille EST son dossier
   * d'origine, puisqu'une corbeille vit à côté de ce qu'elle recueille.
   *
   * Un `rename` SFTP échoue si la cible existe déjà — c'est exactement ce
   * qu'on veut : restaurer ne doit jamais écraser ce qui a repris la place.
   */
  async restore(entry: TrashEntry, dir: string): Promise<boolean> {
    const target = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
    try {
      await this.sftp.moveTo(entry.path, target);
      this.activity.log('rename', 'remote', target, 'restauré de la corbeille');
      this.touched();
      await this.sftp.refresh();
      this.toasts.success(`« ${entry.name} » restauré`, { detail: dir });
      return true;
    } catch (error) {
      this.activity.log('rename', 'remote', entry.path, String(error), false);
      this.toasts.error(this.t('trash.restoreFailed', { name: entry.name }), {
        detail: this.t('trash.restoreHint'),
      });
      return false;
    }
  }

  /** Supprime une entrée de la corbeille, pour de bon. */
  async destroy(entry: TrashEntry): Promise<boolean> {
    try {
      await this.sftp.removeSilently(entry.path, entry.isDir);
      this.activity.log('remove', 'remote', entry.path, 'supprimé de la corbeille');
      this.touched();
      return true;
    } catch (error) {
      this.activity.log('remove', 'remote', entry.path, String(error), false);
      return false;
    }
  }

  /** Vide la corbeille d'un dossier. Rend le nombre d'éléments retirés. */
  async empty(dir: string): Promise<number> {
    const entries = await this.list(dir);
    let removed = 0;
    for (const entry of entries) {
      if (await this.destroy(entry)) {
        removed++;
      }
    }
    if (removed) {
      this.toasts.success(this.t('trash.emptied'), {
        detail: `${removed} élément${removed > 1 ? 's' : ''} supprimé${removed > 1 ? 's' : ''}`,
      });
    }
    return removed;
  }

  /**
   * Purge par âge la corbeille d'un dossier. Rend ce qui a été retiré.
   *
   * Une entrée sans date dans son nom (déposée à la main) n'est jamais
   * purgée : on ne jette pas ce qu'on n'a pas mis là.
   */
  async purge(dir: string): Promise<number> {
    const days = this.settings.trashDays();
    if (!this.available() || days <= 0) {
      return 0;
    }
    const limit = Date.now() / 1000 - days * 86400;
    let removed = 0;
    try {
      const entries = await invoke<TrashEntry[]>('sftp_trash_list', {
        connectionId: this.sftp.connectionId(),
        dir,
      });
      for (const entry of entries.filter((e) => e.at > 0 && e.at < limit)) {
        await this.sftp.removeSilently(entry.path, entry.isDir);
        removed++;
      }
    } catch {
      // Pas de corbeille ici, ou droits refusés : rien à purger, rien à dire.
      return removed;
    }
    if (removed) {
      this.activity.log('remove', 'remote', dir, `${removed} purgés de la corbeille`);
    }
    return removed;
  }

  /** Ce que la corbeille d'un dossier occupe, en octets. */
  size(dir: string): Promise<number> {
    return invoke<number>('sftp_trash_size', {
      connectionId: this.sftp.connectionId(),
      dir,
    }).catch(() => 0);
  }
}
