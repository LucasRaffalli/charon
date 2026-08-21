import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  ConnectionParams,
  FileEntryDto,
  RemoteProtocol,
  ServerEnvironment,
  ServerProtection,
} from '@app/interfaces';
import { ActivityLogService } from '@app/services/activity-log.service';
import { FileBrowserState } from '@app/services/file-browser-state';

/** Balise émise par le backend quand la clé d'un hôte inconnu attend confirmation. */
const UNKNOWN_KEY_TAG = 'CHARON_UNKNOWN_KEY:';

/** Navigation et transferts sur le serveur distant, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class SftpService extends FileBrowserState {
  private readonly activity = inject(ActivityLogService);
  private readonly _connectionId = signal<string | null>(null);
  private readonly _pendingKey = signal<string | null>(null);
  private readonly _protocol = signal<RemoteProtocol>('sftp');
  private readonly _environment = signal<ServerEnvironment | null>(null);
  private readonly _protection = signal<ServerProtection | null>(null);
  private readonly _host = signal('');

  readonly connectionId = this._connectionId.asReadonly();
  readonly connected = computed(() => this._connectionId() !== null);
  readonly protocol = this._protocol.asReadonly();
  /** Environnement du serveur connecté (badge PROD permanent si « prod »). */
  readonly environment = this._environment.asReadonly();
  /** Garde-fou de la session : 'confirm' (retaper l'hôte) ou 'readonly'. */
  readonly protection = this._protection.asReadonly();
  /** Hôte de la session (utilisé par la confirmation renforcée). */
  readonly host = this._host.asReadonly();

  /** Refus central en lecture seule : couvre menus, palette, drag & drop. */
  private guardWritable(action: string, target: string): void {
    if (this._protection() === 'readonly') {
      const message = 'Serveur en lecture seule — action refusée.';
      this.activity.log('error', 'remote', target, `${action} : lecture seule`, false);
      throw message;
    }
  }

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
      this.activity.log('disconnect', 'remote', event.payload, 'inactivité');
    });
  }

  protected fetchEntries(path: string): Promise<FileEntryDto[]> {
    return this.withConnection((id) =>
      invoke<FileEntryDto[]>(this.commandFor('list_dir'), { connectionId: id, path }),
    );
  }

  protected async createDir(path: string): Promise<void> {
    this.guardWritable('mkdir', path);
    try {
      await this.withConnection((id) =>
        invoke(this.commandFor('mkdir'), { connectionId: id, path }),
      );
      this.activity.log('mkdir', 'remote', path);
    } catch (error) {
      this.activity.log('mkdir', 'remote', path, String(error), false);
      throw error;
    }
  }

  /** Fichier : suppression simple. Dossier : suppression récursive
   *  (la confirmation renforcée est gérée par l'UI en amont). */
  protected async removeEntry(path: string, isDir: boolean): Promise<void> {
    this.guardWritable('suppression', path);
    try {
      await this.withConnection((id) =>
        isDir
          ? invoke(this.commandFor('remove_all'), { connectionId: id, path })
          : invoke(this.commandFor('remove'), { connectionId: id, path, isDir }),
      );
      this.activity.log('remove', 'remote', path, isDir ? 'récursif' : null);
    } catch (error) {
      this.activity.log('remove', 'remote', path, String(error), false);
      throw error;
    }
  }

  protected async renameEntry(from: string, to: string): Promise<void> {
    this.guardWritable('renommage', from);
    try {
      await this.withConnection((id) =>
        invoke(this.commandFor('rename'), { connectionId: id, from, to }),
      );
      this.activity.log('rename', 'remote', from, `→ ${to}`);
    } catch (error) {
      this.activity.log('rename', 'remote', from, String(error), false);
      throw error;
    }
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
    this._environment.set(params.environment ?? null);
    this._protection.set(params.protection ?? null);
    this._host.set(params.host);
    this._connectionId.set(id);
    this.activity.log('connect', 'remote', id);

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
    this.activity.log('disconnect', 'remote', id);
    this._connectionId.set(null);
    this._protocol.set('sftp');
    this._environment.set(null);
    this._protection.set(null);
    this._host.set('');
    this._currentPath.set('/');
    this._entries.set([]);
    this._error.set(null);
  }

  private withConnection<T>(operation: (id: string) => Promise<T>): Promise<T> {
    const id = this._connectionId();
    return id ? operation(id) : Promise.reject('Aucune connexion active');
  }
}
