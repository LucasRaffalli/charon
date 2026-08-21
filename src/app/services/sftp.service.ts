import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { ConnectionParams, FileEntryDto, RemoteProtocol } from '@app/interfaces';
import { FileBrowserState } from '@app/services/file-browser-state';

/** Balise émise par le backend quand la clé d'un hôte inconnu attend confirmation. */
const UNKNOWN_KEY_TAG = 'CHARON_UNKNOWN_KEY:';

/** Navigation et transferts sur le serveur distant, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class SftpService extends FileBrowserState {
  private readonly _connectionId = signal<string | null>(null);
  private readonly _pendingKey = signal<string | null>(null);
  private readonly _protocol = signal<RemoteProtocol>('sftp');

  readonly connectionId = this._connectionId.asReadonly();
  readonly connected = computed(() => this._connectionId() !== null);
  readonly protocol = this._protocol.asReadonly();

  /** Nom de la commande backend selon le protocole actif (sftp_* ou ftp_*). */
  commandFor(base: string): string {
    return (this._protocol() === 'sftp' ? 'sftp_' : 'ftp_') + base;
  }

  /** Empreinte de la clé d'un serveur inconnu, en attente de confirmation utilisateur. */
  readonly pendingKey = this._pendingKey.asReadonly();

  constructor() {
    super();
    // Le backend ferme les connexions inactives : retour à l'écran de
    // connexion avec un message clair.
    void listen<string>('connection:idle-closed', (event) => {
      if (event.payload !== this._connectionId()) {
        return;
      }
      this._connectionId.set(null);
      this._currentPath.set('/');
      this._entries.set([]);
      this._error.set('Session fermée pour inactivité.');
    });
  }

  protected fetchEntries(path: string): Promise<FileEntryDto[]> {
    return this.withConnection((id) =>
      invoke<FileEntryDto[]>(this.commandFor('list_dir'), { connectionId: id, path }),
    );
  }

  protected createDir(path: string): Promise<void> {
    return this.withConnection((id) => invoke(this.commandFor('mkdir'), { connectionId: id, path }));
  }

  /** Fichier : suppression simple. Dossier : suppression récursive
   *  (la confirmation renforcée est gérée par l'UI en amont). */
  protected removeEntry(path: string, isDir: boolean): Promise<void> {
    return this.withConnection((id) =>
      isDir
        ? invoke(this.commandFor('remove_all'), { connectionId: id, path })
        : invoke(this.commandFor('remove'), { connectionId: id, path, isDir }),
    );
  }

  protected renameEntry(from: string, to: string): Promise<void> {
    return this.withConnection((id) =>
      invoke(this.commandFor('rename'), { connectionId: id, from, to }),
    );
  }

  async connect(params: ConnectionParams, acceptNewKey?: string): Promise<void> {
    this._pendingKey.set(null);
    const protocol = params.protocol ?? 'sftp';

    const id = await this.run(() =>
      protocol === 'sftp'
        ? invoke<string>('sftp_connect', {
            host: params.host,
            port: params.port,
            user: params.user,
            password: params.password ?? null,
            keyPath: params.keyPath ?? null,
            keyPassphrase: params.keyPassphrase ?? null,
            acceptNewKey: acceptNewKey ?? null,
            profileId: params.profileId ?? null,
          })
        : invoke<string>('ftp_connect', {
            host: params.host,
            port: params.port,
            user: params.user,
            password: params.password ?? null,
            secure: protocol === 'ftps',
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

    this._protocol.set(protocol);
    this._connectionId.set(id);

    if (protocol === 'sftp') {
      // Dossier personnel si possible, racine sinon.
      if (!(await this.listDir(`/home/${params.user}`))) {
        this._error.set(null);
        await this.listDir('/');
      }
    } else {
      // FTP : la racine vue par le serveur (souvent le home chrooté).
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

    await this.run(() => invoke(this.commandFor('disconnect'), { connectionId: id }));
    this._connectionId.set(null);
    this._protocol.set('sftp');
    this._currentPath.set('/');
    this._entries.set([]);
    this._error.set(null);
  }

  private withConnection<T>(operation: (id: string) => Promise<T>): Promise<T> {
    const id = this._connectionId();
    return id ? operation(id) : Promise.reject('Aucune connexion active');
  }
}
