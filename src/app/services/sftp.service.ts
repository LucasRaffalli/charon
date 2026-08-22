import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import {
  ConnectionParams,
  FileEntryDto,
  RemoteProtocol,
  ServerEnvironment,
  ServerProtection,
  StatInfo,
} from '@app/interfaces';
import { ActivityLogService } from '@app/services/activity-log.service';
import { FileBrowserState } from '@app/services/file-browser-state';

/** Opérations qu'un `sudo` peut réexécuter (whitelist, côté backend aussi). */
type SudoOp = 'mkdir' | 'touch' | 'rm_file' | 'rm_dir' | 'rename';

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
      await this.escalateOnDenied('mkdir', path, undefined, () =>
        this.withConnection((id) => invoke(this.commandFor('mkdir'), { connectionId: id, path })),
      );
      this.activity.log('mkdir', 'remote', path);
    } catch (error) {
      this.activity.log('mkdir', 'remote', path, String(error), false);
      throw error;
    }
  }

  protected async createFile(path: string): Promise<void> {
    this.guardWritable('création de fichier', path);
    if (this._protocol() !== 'sftp') {
      throw 'Création de fichier disponible en SFTP uniquement.';
    }
    try {
      await this.escalateOnDenied('touch', path, undefined, () =>
        this.withConnection((id) => invoke('sftp_create_file', { connectionId: id, path })),
      );
      this.activity.log('mkdir', 'remote', path, 'fichier');
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
      await this.escalateOnDenied(isDir ? 'rm_dir' : 'rm_file', path, undefined, () =>
        this.withConnection((id) =>
          isDir
            ? invoke(this.commandFor('remove_all'), { connectionId: id, path })
            : invoke(this.commandFor('remove'), { connectionId: id, path, isDir }),
        ),
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
      await this.escalateOnDenied('rename', from, to, () =>
        this.withConnection((id) => invoke(this.commandFor('rename'), { connectionId: id, from, to })),
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

  /** Métadonnées d'un fichier distant (SFTP uniquement). */
  stat(path: string): Promise<StatInfo | undefined> {
    return this.withConnection((id) =>
      invoke<StatInfo>('sftp_stat', { connectionId: id, path }),
    ).catch(() => undefined);
  }

  /** Début d'un fichier distant en texte, borné (SFTP uniquement). */
  readText(path: string, maxBytes: number): Promise<string | undefined> {
    return this.withConnection((id) =>
      invoke<string>('sftp_read_text', { connectionId: id, path, maxBytes }),
    ).catch(() => undefined);
  }

  private withConnection<T>(operation: (id: string) => Promise<T>): Promise<T> {
    const id = this._connectionId();
    return id ? operation(id) : Promise.reject('Aucune connexion active');
  }

  // --- API médiée pour les modules (mêmes garde-fous que l'utilisateur) ---

  /** Liste un chemin sans changer le dossier courant (lecture seule). */
  moduleList(path: string): Promise<FileEntryDto[]> {
    return this.withConnection((id) =>
      invoke<FileEntryDto[]>(this.commandFor('list_dir'), { connectionId: id, path }),
    );
  }

  /** Rafraîchit la vue si l'écriture touche le dossier courant. */
  private async refreshIfCurrent(path: string): Promise<void> {
    const parent = path.replace(/\/[^/]*$/, '') || '/';
    if (parent === this._currentPath()) {
      await this.refresh();
    }
  }

  async moduleMkdir(path: string): Promise<void> {
    await this.createDir(path);
    await this.refreshIfCurrent(path);
  }

  async moduleCreateFile(path: string): Promise<void> {
    await this.createFile(path);
    await this.refreshIfCurrent(path);
  }

  async moduleRemove(path: string, isDir: boolean): Promise<void> {
    await this.removeEntry(path, isDir);
    await this.refreshIfCurrent(path);
  }

  async moduleRename(from: string, to: string): Promise<void> {
    await this.renameEntry(from, to);
    await this.refreshIfCurrent(from);
  }

  async moduleWriteText(path: string, content: string): Promise<void> {
    this.guardWritable('écriture', path);
    if (this._protocol() !== 'sftp') {
      throw 'Écriture de fichier disponible en SFTP uniquement.';
    }
    await this.withConnection((id) =>
      invoke('sftp_write_text', { connectionId: id, path, content }),
    );
    this.activity.log('edit', 'remote', path, 'module');
    await this.refreshIfCurrent(path);
  }

  /** Instantané système du serveur (disque, mémoire, charge, process). */
  systemStats(): Promise<unknown> {
    if (this._protocol() !== 'sftp') {
      return Promise.reject('Stats système disponibles en SFTP uniquement.');
    }
    return this.withConnection((id) => invoke('sftp_system_stats', { connectionId: id }));
  }

  /** Usage disque des sous-dossiers d'un chemin (peut être lent). */
  diskUsage(path: string): Promise<string> {
    if (this._protocol() !== 'sftp') {
      return Promise.reject('Analyse disque disponible en SFTP uniquement.');
    }
    return this.withConnection((id) => invoke<string>('sftp_disk_usage', { connectionId: id, path }));
  }

  /** Une erreur ressemble-t-elle à un refus de permission ? */
  private isPermissionDenied(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return (
      message.includes('permission') ||
      message.includes('denied') ||
      message.includes('not permitted')
    );
  }

  /**
   * Exécute `run` ; si ça échoue **pour permission** (SFTP uniquement), rejoue
   * l'opération whitelistée via `sudo`. Le mot de passe est demandé par une
   * invite macOS **native** côté backend — il ne transite jamais par la
   * WebView. Annulation de l'invite = on remonte l'erreur d'origine.
   */
  private async escalateOnDenied(
    op: SudoOp,
    path: string,
    path2: string | undefined,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (this._protocol() !== 'sftp' || !this.isPermissionDenied(error)) {
        throw error;
      }
      try {
        await this.withConnection((id) =>
          invoke('sftp_sudo', { connectionId: id, op, path, path2: path2 ?? null }),
        );
        const action =
          op === 'mkdir' || op === 'touch' ? 'mkdir' : op === 'rename' ? 'rename' : 'remove';
        this.activity.log(action, 'remote', path, 'sudo');
      } catch (sudoError) {
        // Invite annulée : on conserve l'erreur de permission d'origine.
        if (String(sudoError).includes('CHARON_SUDO_CANCELLED')) {
          throw error;
        }
        throw sudoError;
      }
    }
  }
}
