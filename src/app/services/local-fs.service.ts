import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { FileEntryDto } from '@app/interfaces';
import { FileBrowserState } from '@app/services/file-browser-state';

/** Navigation dans le disque local, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class LocalFsService extends FileBrowserState {
  private initialized = false;

  protected fetchEntries(path: string): Promise<FileEntryDto[]> {
    return invoke<FileEntryDto[]>('local_list_dir', { path });
  }

  protected createDir(path: string): Promise<void> {
    return invoke('local_mkdir', { path });
  }

  protected removeEntry(path: string, isDir: boolean): Promise<void> {
    return invoke('local_remove', { path, isDir });
  }

  protected renameEntry(from: string, to: string): Promise<void> {
    return invoke('local_rename', { from, to });
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
