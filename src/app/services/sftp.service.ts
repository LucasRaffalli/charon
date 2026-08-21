import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { ConnectionParams, FileEntryDto } from '@app/interfaces';
import { FileBrowserState } from '@app/services/file-browser-state';

/** Balise émise par le backend quand la clé d'un hôte inconnu attend confirmation. */
const UNKNOWN_KEY_TAG = 'CHARON_UNKNOWN_KEY:';

/** Navigation et transferts sur le serveur distant, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class SftpService extends FileBrowserState {
  private readonly _connectionId = signal<string | null>(null);
  private readonly _pendingKey = signal<string | null>(null);

  readonly connectionId = this._connectionId.asReadonly();
  readonly connected = computed(() => this._connectionId() !== null);

  /** Empreinte de la clé d'un serveur inconnu, en attente de confirmation utilisateur. */
  readonly pendingKey = this._pendingKey.asReadonly();

  protected fetchEntries(path: string): Promise<FileEntryDto[]> {
    return this.withConnection((id) =>
      invoke<FileEntryDto[]>('sftp_list_dir', { connectionId: id, path }),
    );
  }

  protected createDir(path: string): Promise<void> {
    return this.withConnection((id) => invoke('sftp_mkdir', { connectionId: id, path }));
  }

  /** Fichier : suppression simple. Dossier : suppression récursive
   *  (la confirmation renforcée est gérée par l'UI en amont). */
  protected removeEntry(path: string, isDir: boolean): Promise<void> {
    return this.withConnection((id) =>
      isDir
        ? invoke('sftp_remove_all', { connectionId: id, path })
        : invoke('sftp_remove', { connectionId: id, path, isDir }),
    );
  }

  protected renameEntry(from: string, to: string): Promise<void> {
    return this.withConnection((id) => invoke('sftp_rename', { connectionId: id, from, to }));
  }

  async connect(params: ConnectionParams, acceptNewKey?: string): Promise<void> {
    this._pendingKey.set(null);
    const id = await this.run(() =>
      invoke<string>('sftp_connect', {
        host: params.host,
        port: params.port,
        user: params.user,
        password: params.password ?? null,
        keyPath: params.keyPath ?? null,
        keyPassphrase: params.keyPassphrase ?? null,
        acceptNewKey: acceptNewKey ?? null,
        profileId: params.profileId ?? null,
      }),
    );
    if (id === undefined) {
      // Hôte inconnu : le backend renvoie l'empreinte à faire confirmer,
      // ce n'est pas une erreur à afficher telle quelle.
      const error = this._error();
      if (error?.startsWith(UNKNOWN_KEY_TAG)) {
        this._pendingKey.set(error.slice(UNKNOWN_KEY_TAG.length));
        this._error.set(null);
      }
      return;
    }

    this._connectionId.set(id);

    // Dossier personnel si possible, racine sinon.
    if (!(await this.listDir(`/home/${params.user}`))) {
      this._error.set(null);
      await this.listDir('/');
    }
  }

  /** À appeler une fois l'empreinte traitée (acceptée ou refusée). */
  clearPendingKey(): void {
    this._pendingKey.set(null);
  }

  /** Signale une erreur de connexion depuis le flux TOFU côté UI. */
  reportError(message: string): void {
    this._error.set(message);
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

  private withConnection<T>(operation: (id: string) => Promise<T>): Promise<T> {
    const id = this._connectionId();
    return id ? operation(id) : Promise.reject('Aucune connexion active');
  }
}
