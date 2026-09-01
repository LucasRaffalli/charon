import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { FileEntryDto, StatInfo } from '@app/interfaces';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { FileBrowserState } from '@app/services/connection/file-browser-state';
import { ToastService } from '@app/services/workspace/toast.service';
import { injectT } from '@app/lang/i18n.service';

/** Navigation dans le disque local, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class LocalFsService extends FileBrowserState {
  private readonly t = injectT();
  private readonly activity = inject(ActivityLogService);
  private readonly toasts = inject(ToastService);
  private initialized = false;

  protected fetchEntries(path: string): Promise<FileEntryDto[]> {
    return invoke<FileEntryDto[]>('local_list_dir', { path });
  }

  protected async createDir(path: string): Promise<void> {
    try {
      await invoke('local_mkdir', { path });
      this.activity.log('mkdir', 'local', path);
    } catch (error) {
      this.activity.log('mkdir', 'local', path, String(error), false);
      throw error;
    }
  }

  protected async createFile(path: string): Promise<void> {
    try {
      await invoke('local_create_file', { path });
      this.activity.log('mkdir', 'local', path, 'fichier');
    } catch (error) {
      this.activity.log('mkdir', 'local', path, String(error), false);
      throw error;
    }
  }

  /** Fichier : suppression simple. Dossier : suppression récursive
   *  (la confirmation renforcée est gérée par l'UI en amont). */
  protected async removeEntry(path: string, isDir: boolean): Promise<void> {
    try {
      await (isDir ? invoke('local_remove_all', { path }) : invoke('local_remove', { path, isDir }));
      this.activity.log('remove', 'local', path, isDir ? 'récursif' : null);
    } catch (error) {
      this.activity.log('remove', 'local', path, String(error), false);
      throw error;
    }
  }

  protected async renameEntry(from: string, to: string): Promise<void> {
    try {
      await invoke('local_rename', { from, to });
      this.activity.log('rename', 'local', from, `→ ${to}`);
    } catch (error) {
      this.activity.log('rename', 'local', from, String(error), false);
      throw error;
    }
  }

  /**
   * Déplace une entrée locale sans passer par le dossier courant : le
   * presse-papiers manipule des chemins absolus des deux côtés.
   */
  async moveTo(from: string, to: string): Promise<void> {
    try {
      await invoke('local_rename', { from, to });
      this.activity.log('rename', 'local', from, `→ ${to}`);
    } catch (error) {
      this.activity.log('rename', 'local', from, String(error), false);
      throw error;
    }
  }

  /** Métadonnées d'un fichier local. */
  stat(path: string): Promise<StatInfo | undefined> {
    return invoke<StatInfo>('local_stat', { path }).catch(() => undefined);
  }

  /** Début d'un fichier local en texte, borné. */
  readText(path: string, maxBytes: number): Promise<string | undefined> {
    return invoke<string>('local_read_text', { path, maxBytes }).catch(() => undefined);
  }

  /**
   * Ouvre le dossier d'ancrage au premier affichage (issue #5), sinon le
   * dossier personnel, la racine en dernier recours.
   *
   * Les replis sont SILENCIEUX, comme pour l'ancre de connexion : un dossier
   * ancré puis supprimé (ou sur un disque débranché) ne doit pas accueillir
   * l'utilisateur par une erreur, il doit juste ne pas s'ouvrir.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // Arriver n'est pas naviguer : `history: false` partout ici, sinon le
    // premier écran proposerait déjà un « dossier précédent » où l'on n'est
    // jamais allé, et l'ancre qui se replie en laisserait deux.
    const anchor = this.settings.localHome().trim();
    if (anchor && (await this.listDir(anchor, { history: false }))) {
      return;
    }
    this._error.set(null);

    const home = await this.run(() => invoke<string>('local_home_dir'));
    if (home !== undefined && (await this.listDir(home, { history: false }))) {
      return;
    }
    this._error.set(null);
    await this.listDir('/', { history: false });
  }

  /**
   * Ancre (ou désancre) le dossier d'ouverture du panneau local. Le journal et
   * le toast vivent ici et non chez l'appelant : le geste se fait depuis le
   * clic droit comme depuis les réglages, et les deux doivent dire la même
   * chose. Un toast est nécessaire : l'effet est pour le prochain démarrage,
   * il n'y a rien à constater tout de suite.
   */
  anchorHere(path: string | null): void {
    this.settings.update({ localHome: path ?? '' });
    this.activity.log(
      'anchor',
      'local',
      path ?? this.currentPath(),
      path ? 'Ouverture du panneau local' : 'Ancre retirée, ouverture au dossier personnel',
    );
    if (path) {
      this.toasts.success(this.t('misc.anchor.localSet'), path);
    } else {
      this.toasts.success(this.t('misc.anchor.localRemoved'), this.t('misc.anchor.localHome'));
    }
  }
}
