import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { ConnectionParams, FileEntryDto } from '@app/interfaces';
import { FileBrowserState } from '@app/services/file-browser-state';

/** Navigation et transferts sur le serveur distant, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class SftpService extends FileBrowserState {
  private readonly _connectionId = signal<string | null>(null);

  readonly connectionId = this._connectionId.asReadonly();
  readonly connected = computed(() => this._connectionId() !== null);

  protected fetchEntries(path: string): Promise<FileEntryDto[]> {
    return this.withConnection((id) =>
      invoke<FileEntryDto[]>('sftp_list_dir', { connectionId: id, path }),
    );
  }

  protected createDir(path: string): Promise<void> {
    return this.withConnection((id) => invoke('sftp_mkdir', { connectionId: id, path }));
  }

  protected removeEntry(path: string, isDir: boolean): Promise<void> {
    return this.withConnection((id) => invoke('sftp_remove', { connectionId: id, path, isDir }));
  }

  protected renameEntry(from: string, to: string): Promise<void> {
    return this.withConnection((id) => invoke('sftp_rename', { connectionId: id, from, to }));
  }

  async connect(params: ConnectionParams): Promise<void> {
    const id = await this.run(() =>
      invoke<string>('sftp_connect', {
        host: params.host,
        port: params.port,
        user: params.user,
        password: params.password ?? null,
        keyPath: params.keyPath ?? null,
        keyPassphrase: params.keyPassphrase ?? null,
      }),
    );
    if (id === undefined) {
      return;
    }

    this._connectionId.set(id);

    // Dossier personnel si possible, racine sinon.
    if (!(await this.listDir(`/home/${params.user}`))) {
      this._error.set(null);
      await this.listDir('/');
    }
  }

  async disconnect(): Promise<void> {
    const id = this._connectionId();
    if (!id) {
      return;
    }

    await this.run(() => invoke('sftp_disconnect', { connectionId: id }));
    this._connectionId.set(null);
    this._currentPath.set('/');
    this._entries.set([]);
    this._error.set(null);
  }

  /** Télécharge un fichier distant. Renvoie la taille écrite, ou undefined en cas d'erreur. */
  download(remotePath: string, localPath: string): Promise<number | undefined> {
    return this.run(() =>
      this.withConnection((id) =>
        invoke<number>('sftp_download', { connectionId: id, remotePath, localPath }),
      ),
    );
  }

  /** Envoie un fichier local. Renvoie la taille écrite, ou undefined en cas d'erreur. */
  upload(localPath: string, remotePath: string): Promise<number | undefined> {
    return this.run(() =>
      this.withConnection((id) =>
        invoke<number>('sftp_upload', { connectionId: id, localPath, remotePath }),
      ),
    );
  }

  private withConnection<T>(operation: (id: string) => Promise<T>): Promise<T> {
    const id = this._connectionId();
    return id ? operation(id) : Promise.reject('Aucune connexion active');
  }
}
