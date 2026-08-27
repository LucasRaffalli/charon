import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { FileEntryDto, StatInfo } from '@app/interfaces';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { FileBrowserState } from '@app/services/connection/file-browser-state';

/** Navigation dans le disque local, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class LocalFsService extends FileBrowserState {
  private readonly activity = inject(ActivityLogService);
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

  /** Métadonnées d'un fichier local. */
  stat(path: string): Promise<StatInfo | undefined> {
    return invoke<StatInfo>('local_stat', { path }).catch(() => undefined);
  }

  /** Début d'un fichier local en texte, borné. */
  readText(path: string, maxBytes: number): Promise<string | undefined> {
    return invoke<string>('local_read_text', { path, maxBytes }).catch(() => undefined);
  }

  /** Ouvre le dossier personnel au premier affichage, la racine en dernier recours. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    const home = await this.run(() => invoke<string>('local_home_dir'));
    if (home !== undefined && (await this.listDir(home))) {
      return;
    }
    this._error.set(null);
    await this.listDir('/');
  }
}
