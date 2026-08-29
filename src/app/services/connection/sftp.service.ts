import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { injectTauriListen } from '@app/services/system/scoped-listen';

import {
  ConnectionParams,
  FileEntry,
  FileEntryDto,
  RemoteProtocol,
  ServerEnvironment,
  ServerProtection,
  StatInfo,
} from '@app/interfaces';
import { injectSessionActivity } from '@app/services/workspace/activity-log.service';
import { FileBrowserState } from '@app/services/connection/file-browser-state';
import { SESSION_ID } from '@app/services/connection/session-token';
import { windowLabel } from '@app/services/system/window-scope';

/** Opérations qu'un `sudo` peut réexécuter (whitelist, côté backend aussi). */
type SudoOp = 'mkdir' | 'touch' | 'rm_file' | 'rm_dir' | 'rename' | 'chmod' | 'chmod_r';

/** Balise émise par le backend quand la clé d'un hôte inconnu attend confirmation. */
const UNKNOWN_KEY_TAG = 'CHARON_UNKNOWN_KEY:';

/** Durée de l'annonce d'arrivée avant de laisser la place à l'explorateur. */
const LANDING_MS = 900;

/** Même balise que celle des transferts, côté Rust. */
const CANCELLED_TAG = 'CHARON_CANCELLED';

/** La session de CETTE fenêtre, pour le rattachement après reload. */
/** Le slot de la première session garde la clé nue (compat) ; les suivantes
 *  suffixent leur identité : `charon:session#s2`. */
const SESSION_KEY = 'charon:session';

interface SavedSession {
  id: string;
  protocol: RemoteProtocol;
  host: string;
  environment: ServerEnvironment | null;
  protection: ServerProtection | null;
  profileId: string | null;
  connectedAt: number;
  path: string;
}

/** Navigation et transferts sur le serveur distant, via le backend Rust. */
@Injectable({ providedIn: 'root' })
export class SftpService extends FileBrowserState {
  private readonly tauriListen = injectTauriListen();
  private readonly activity = injectSessionActivity();
  /** L'identité de la session qui possède ce service (s1, s2…). */
  private readonly sessionId = inject(SESSION_ID, { optional: true }) ?? 's1';

  /** Le slot sessionStorage de CETTE session. */
  private readonly sessionSlot =
    this.sessionId === 's1' ? SESSION_KEY : `${SESSION_KEY}#${this.sessionId}`;

  private readonly _connectionId = signal<string | null>(null);
  private readonly _pendingKey = signal<string | null>(null);
  private readonly _protocol = signal<RemoteProtocol>('sftp');
  private readonly _environment = signal<ServerEnvironment | null>(null);
  private readonly _protection = signal<ServerProtection | null>(null);
  private readonly _host = signal('');
  private readonly _profileId = signal<string | null>(null);
  /** Instant de la connexion : borne basse du bilan de session (idée 06). */
  private readonly _connectedAt = signal(0);

  readonly connectionId = this._connectionId.asReadonly();
  readonly connected = computed(() => this._connectionId() !== null);

  /**
   * Connecté ET la traversée annoncée. L'écran de connexion reste à l'écran ce
   * court instant pour dire « Bonne traversée. » : sans lui, la connexion
   * réussie ferait disparaître la page avant qu'elle ait pu le montrer.
   *
   * C'est cette valeur, et non `connected`, qui décide d'afficher
   * l'explorateur.
   */
  private readonly _settled = signal(false);
  readonly settled = this._settled.asReadonly();
  readonly protocol = this._protocol.asReadonly();
  /** Environnement du serveur connecté (badge PROD permanent si « prod »). */
  readonly environment = this._environment.asReadonly();
  /** Garde-fou de la session : 'confirm' (retaper l'hôte) ou 'readonly'. */
  readonly protection = this._protection.asReadonly();
  /** Hôte de la session (utilisé par la confirmation renforcée). */
  readonly host = this._host.asReadonly();
  /**
   * Profil de la session, s'il y en a un : une connexion peut très bien se
   * faire sans enregistrer quoi que ce soit. Sans profil, rien à quoi rattacher
   * un dossier d'arrivée.
   */
  readonly profileId = this._profileId.asReadonly();
  readonly connectedAt = this._connectedAt.asReadonly();

  /** Refus central en lecture seule : couvre menus, palette, drag & drop. */
  private guardWritable(action: string, target: string): void {
    if (this._protection() === 'readonly') {
      const message = 'Serveur en lecture seule : action refusée.';
      this.activity.log('error', 'remote', target, `${action} : lecture seule`, false);
      throw message;
    }
  }

  /** Nom de la commande backend selon le protocole actif (sftp_* ou ftp_*). */
  /**
   * Liste un dossier **sans toucher à l'état de l'explorateur** : ni chemin
   * courant, ni entrées, ni indicateur de chargement.
   *
   * La palette s'en sert pour regarder dans un dossier sans y emmener
   * l'application : cliquer pour voir et cliquer pour aller sont deux gestes
   * différents, et les confondre déplace l'explorateur sans qu'on l'ait demandé.
   */
  async peekDir(path: string): Promise<FileEntry[]> {
    const id = this._connectionId();
    if (!id) {
      return [];
    }
    try {
      const entries = await invoke<FileEntryDto[]>(this.commandFor('list_dir'), {
        connectionId: id,
        path,
      });
      return entries.map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size }));
    } catch {
      return [];
    }
  }

  commandFor(base: string): string {
    return (this._protocol() === 'sftp' ? 'sftp_' : 'ftp_') + base;
  }

  /** Empreinte de la clé d'un serveur inconnu, en attente de confirmation utilisateur. */
  readonly pendingKey = this._pendingKey.asReadonly();

  constructor() {
    super();
    // Rattachement après reload : la connexion vit dans le backend, pas dans
    // la webview.
    void this.reattach();
    // Le backend ferme les connexions inactives : retour à l'écran de
    // connexion avec un message clair.
    // Le serveur s'est arrêté, le réseau a lâché, ou la session a été coupée
    // à distance : la sentinelle du backend l'a vu, on le dit et on ramène à
    // l'écran de connexion au lieu de rester « connecté » devant un cadavre.
    this.tauriListen<string>('connection:lost', (event) => {
      if (event.payload !== this._connectionId()) {
        return;
      }
      this._connectionId.set(null);
      this._settled.set(false);
      this._currentPath.set('/');
      this._entries.set([]);
      this.clearSeen();
      this.forgetSession();
      this._error.set(
        'La connexion au serveur a été perdue : serveur arrêté, réseau coupé ou session fermée à distance.',
      );
      this.activity.log('disconnect', 'remote', event.payload, 'connexion perdue', false);
    });

    this.tauriListen<string>('connection:idle-closed', (event) => {
      if (event.payload !== this._connectionId()) {
        return;
      }
      this._connectionId.set(null);
      this._settled.set(false);
      this._currentPath.set('/');
      this._entries.set([]);
      this.clearSeen();
      this.forgetSession();
      this._error.set('Session fermée pour inactivité.');
      this.activity.log('disconnect', 'remote', event.payload, 'inactivité');
    });

    // Une autre fenêtre a modifié un dossier de ce serveur (collage, glissé,
    // coupé) : si on le regarde, on se met à jour. `origin` écarte ses
    // propres gestes, déjà suivis d'un refresh.
    this.tauriListen<{ server: string; dir: string; origin: string }>(
      'flotte:dir-changed',
      ({ payload }) => {
        if (payload.origin === windowLabel()) {
          return;
        }
        const id = this._connectionId();
        if (!id || id.split('#')[0] !== payload.server || this.currentPath() !== payload.dir) {
          return;
        }
        void this.refresh();
      },
    );
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

  /**
   * Annule une connexion en cours.
   *
   * C'est une vraie annulation, pas une connexion suivie d'une fermeture : le
   * backend abandonne le futur d'ouverture, ce qui interrompt la poignée de
   * main là où elle en est. Rien ne s'ouvre côté serveur.
   */
  cancelConnect(): void {
    const attempt = this.attemptId;
    if (!attempt) {
      return;
    }
    void invoke('connect_cancel', { attemptId: attempt }).catch(() => undefined);
  }

  /** Identifiant de la tentative en cours, pour pouvoir l'annuler. */
  private attemptId: string | null = null;

  async connect(params: ConnectionParams, acceptNewKey?: string): Promise<void> {
    this._pendingKey.set(null);
    const protocol = params.protocol ?? 'sftp';
    const attempt = `connect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.attemptId = attempt;

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
            authMethod: params.authMethod ?? null,
            attemptId: attempt,
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
    this.attemptId = null;

    // Annulation demandée : le backend a rendu la main sans rien ouvrir, il
    // n'y a ni erreur à montrer ni session à ranger.
    if (this._error() === CANCELLED_TAG) {
      this._error.set(null);
      return;
    }

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

    this.clearSeen();
    this._protocol.set(protocol);
    this._profileId.set(params.profileId ?? null);
    this.rememberSession(id, params, protocol);
    this._environment.set(params.environment ?? null);
    this._protection.set(params.protection ?? null);
    this._host.set(params.host);
    this._connectionId.set(id);
    this.activity.log('connect', 'remote', id);
    this._connectedAt.set(Date.now());
    setTimeout(() => this._settled.set(true), LANDING_MS);

    // L'ancre du profil d'abord : c'est le dossier où l'on travaille, et le
    // retraverser à chaque connexion n'apprend rien à personne. Elle peut avoir
    // disparu du serveur depuis, d'où le repli silencieux sur l'arrivée
    // habituelle plutôt qu'une erreur au premier écran.
    const anchor = params.anchor?.trim();
    if (anchor && (await this.listDir(anchor))) {
      return;
    }
    this._error.set(null);

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

  /**
   * Le rattachement après un reload de fenêtre.
   *
   * `sessionStorage` n'est pas partagé entre webviews : chaque fenêtre y note
   * SA session. Au démarrage, si la connexion vit encore dans le pool du
   * backend (qui, lui, ne meurt pas avec la webview), on la reprend là où
   * elle était : recharger une fenêtre ne déconnecte rien.
   */
  private async reattach(): Promise<void> {
    // Chaque session lit SON slot : deux sessions ne peuvent pas se disputer
    // la même connexion du pool, leurs slots sont distincts par identité.
    let saved: SavedSession | null = null;
    try {
      const raw = sessionStorage.getItem(this.sessionSlot);
      saved = raw ? (JSON.parse(raw) as SavedSession) : null;
    } catch {
      return;
    }
    if (!saved || saved.protocol !== 'sftp') {
      return;
    }
    const alive = await invoke<string[]>('sftp_active_connections').catch(() => [] as string[]);
    if (!alive.includes(saved.id)) {
      this.forgetSession();
      return;
    }
    this._connectionId.set(saved.id);
    this._protocol.set(saved.protocol);
    this._host.set(saved.host);
    this._environment.set(saved.environment);
    this._protection.set(saved.protection);
    this._profileId.set(saved.profileId);
    this._connectedAt.set(saved.connectedAt);
    // Pas de traversée à rejouer : on est déjà à bord.
    this._settled.set(true);
    await this.listDir(saved.path);
  }

  /** Tient le chemin de la sauvegarde à jour : le reload ramène au même dossier. */
  private readonly trackPath = effect(() => {
    const path = this.currentPath();
    if (!this.connected()) {
      return;
    }
    try {
      const raw = sessionStorage.getItem(this.sessionSlot);
      if (raw) {
        const saved = JSON.parse(raw) as SavedSession;
        saved.path = path;
        sessionStorage.setItem(this.sessionSlot, JSON.stringify(saved));
      }
    } catch {
      // au pire, le reload ramènera à la racine
    }
  });

  private rememberSession(id: string, params: ConnectionParams, protocol: RemoteProtocol): void {
    try {
      const saved: SavedSession = {
        id,
        protocol,
        host: params.host,
        environment: params.environment ?? null,
        protection: params.protection ?? null,
        profileId: params.profileId ?? null,
        connectedAt: Date.now(),
        path: '/',
      };
      sessionStorage.setItem(this.sessionSlot, JSON.stringify(saved));
    } catch {
      // Stockage indisponible : le reload ramènera à l'écran de connexion.
    }
  }

  private forgetSession(): void {
    try {
      sessionStorage.removeItem(this.sessionSlot);
    } catch {
      // rien à faire
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
    this.forgetSession();
    this.activity.log('disconnect', 'remote', id);
    this._connectionId.set(null);
    this._settled.set(false);
    this._protocol.set('sftp');
    this._environment.set(null);
    this._protection.set(null);
    this._host.set('');
    this._profileId.set(null);
    this._currentPath.set('/');
    this._entries.set([]);
    this.clearSeen();
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
    if (!id) {
      return Promise.reject('Aucune connexion active');
    }
    // Toute erreur déclenche la sonde : si la session est morte, le backend
    // émet connection:lost dans les secondes qui suivent au lieu de laisser
    // l'utilisateur « connecté » à collectionner des timeouts jusqu'à ce que
    // le keepalive conclue (~95 s). Une erreur légitime (droits refusés) sonde
    // pour rien, mais un metadata("/") ne coûte presque rien.
    return operation(id).catch((error: unknown) => {
      if (this.protocol() === 'sftp' && this._connectionId() === id) {
        void invoke('sftp_probe', { connectionId: id }).catch(() => undefined);
      }
      throw error;
    });
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

  /**
   * Change les permissions (idée 07), avec escalade sudo si le serveur refuse
   * — c'est le cas courant sur les fichiers d'un autre utilisateur, et
   * l'escalade existait déjà pour mkdir, rm et mv.
   */
  async chmod(path: string, mode: string, recursive: boolean): Promise<void> {
    this.guardWritable('permissions', path);
    await this.escalateOnDenied(recursive ? 'chmod_r' : 'chmod', path, mode, () =>
      this.withConnection((id) =>
        invoke('sftp_chmod', { connectionId: id, path, mode, recursive }),
      ),
    );
  }

  /**
   * Déplace une entrée (rename SFTP), sans rafraîchir : un lot relit le
   * dossier une seule fois. Passe par `renameEntry`, donc par la lecture
   * seule et l'escalade sudo comme un renommage ordinaire.
   */
  async moveTo(from: string, to: string): Promise<void> {
    await this.renameEntry(from, to);
  }

  /**
   * Supprime sans rafraîchir : les suppressions en lot relisent le dossier
   * une seule fois, à la fin. Les garde-fous (lecture seule, escalade sudo)
   * restent ceux de `removeEntry`.
   */
  async removeSilently(path: string, isDir: boolean): Promise<void> {
    await this.removeEntry(path, isDir);
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
   * invite macOS **native** côté backend : il ne transite jamais par la
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
          op === 'mkdir' || op === 'touch'
            ? 'mkdir'
            : op === 'rename' || op === 'chmod' || op === 'chmod_r'
              ? 'rename'
              : 'remove';
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
