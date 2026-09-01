import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { SESSION_ID } from '@app/services/connection/session-token';
import { scopedKey } from '@app/services/system/window-scope';
import { invoke } from '@tauri-apps/api/core';
import { injectTauriListen } from '@app/services/system/scoped-listen';

import { Transfer, TransferDirection, TransferProgressEvent } from '@app/interfaces';
import { injectSessionActivity } from '@app/services/workspace/activity-log.service';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { injectT } from '@app/lang/i18n.service';

/** Balise émise par le backend quand un transfert est annulé. */
const CANCELLED_TAG = 'CHARON_CANCELLED';
/** Suffixe des fichiers partiels côté backend. */
const PART_SUFFIX = '.charonpart';

// Par fenêtre : voir scopedKey. Ce qui appartient à une session ne doit
// pas être écrasé par la fenêtre d'à côté.
const STORAGE_BASE = scopedKey('charon:transfers');

/**
 * File de transferts : streaming côté Rust, progression par events Tauri.
 * La file est persistée : un transfert coupé (erreur, fermeture de l'app)
 * revient en « interrompu » et peut reprendre là où il s'était arrêté,
 * une fois reconnecté au même serveur.
 */
/** Même serveur, sessions confondues : la partie stable avant le nonce `#`. */
export const sameServer = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.split('#')[0] === b.split('#')[0];

/**
 * Au-delà, hacher les deux côtés coûte plus longtemps que le transfert
 * lui-même : la vérification est annoncée « ignorée », jamais faite en
 * silence.
 */
const VERIFY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class TransfersService {
  private readonly t = injectT();
  private readonly tauriListen = injectTauriListen();
  private readonly sftp = inject(SftpService);

  /** La première session garde la clé nue (compat) ; les suivantes suffixent
   *  leur identité, sinon deux files se réécriraient l'une l'autre. */
  private readonly sessionId = inject(SESSION_ID, { optional: true }) ?? 's1';
  private readonly storageKey =
    this.sessionId === 's1' ? STORAGE_BASE : `${STORAGE_BASE}#${this.sessionId}`;
  private readonly settings = inject(SettingsService);
  private readonly toasts = inject(ToastService);
  private readonly localFs = inject(LocalFsService);
  private readonly activity = injectSessionActivity();
  private readonly _transfers = signal<Transfer[]>(this.load());

  readonly transfers = this._transfers.asReadonly();
  readonly activeCount = computed(
    () => this._transfers().filter((t) => t.status === 'active').length,
  );

  constructor() {
    this.tauriListen<TransferProgressEvent>('transfer:progress', (event) => {
      const { id, transferred, total } = event.payload;
      // Le débit se dérive de ce que l'événement porte déjà : la moyenne
      // depuis le départ, plus stable à lire qu'une mesure instantanée qui
      // saute à chaque à-coup du réseau.
      const started = this._transfers().find((t) => t.id === id)?.startedAt;
      const seconds = started ? (Date.now() - started) / 1000 : 0;
      const speed = seconds > 0.5 ? Math.round(transferred / seconds) : 0;
      this.patch(id, { transferred, total, speed });
    });

    // Persistance débouncée (même patron que le dock) : chaque event de
    // progression réécrit la file, sérialiser + écrire à chaque tick
    // bloquait le thread principal pour rien.
    effect((onCleanup) => {
      this._transfers(); // la dépendance ; la sérialisation attend le calme
      const handle = setTimeout(() => {
        localStorage.setItem(this.storageKey, JSON.stringify(untracked(() => this._transfers())));
      }, 300);
      onCleanup(() => clearTimeout(handle));
    });
  }

  /** Télécharge un fichier distant. Résout à true si le transfert a abouti. */
  download(remotePath: string, localPath: string, name: string): Promise<boolean> {
    return this.start('download', name, remotePath, localPath);
  }

  /** Envoie un fichier local. Résout à true si le transfert a abouti. */
  upload(localPath: string, remotePath: string, name: string): Promise<boolean> {
    return this.start('upload', name, remotePath, localPath);
  }

  /** Annule tous les transferts actifs (⌘. du vocabulaire des gestes). */
  cancelAll(): void {
    for (const transfer of this._transfers().filter((t) => t.status === 'active')) {
      this.cancel(transfer.id);
    }
  }

  /**
   * Un pont : copie un fichier d'un serveur à un autre, en flux, via le
   * backend. Ni resume ni vérification sha256 en v1 (les deux côtés sont
   * distants, le plafond de la vérification s'appliquerait deux fois).
   */
  async bridge(
    fromConnectionId: string,
    fromPath: string,
    toPath: string,
    name: string,
    route: string,
  ): Promise<boolean> {
    const id = crypto.randomUUID();
    this._transfers.update((list) => [
      {
        id,
        name,
        direction: 'remote' as const,
        transferred: 0,
        total: 0,
        status: 'active' as const,
        error: null,
        connectionId: fromConnectionId,
        remotePath: fromPath,
        localPath: toPath,
        startedAt: Date.now(),
        speed: 0,
        route,
      },
      ...list,
    ]);

    try {
      const written = await invoke<number>('sftp_transfer_remote', {
        fromConnection: fromConnectionId,
        fromPath,
        toConnection: this.sftp.connectionId(),
        toPath,
        transferId: id,
      });
      this.patch(id, { status: 'done', transferred: written });
      this.activity.log('upload', 'remote', toPath, `${written} octets via le pont`);
      return true;
    } catch (error) {
      const message = typeof error === 'string' ? error : String(error);
      if (message === CANCELLED_TAG) {
        this.patch(id, { status: 'cancelled' });
        this.activity.log('cancel', 'remote', toPath);
      } else {
        // Pas de reprise pour un pont : l'erreur est finale.
        this.patch(id, { status: 'error', error: message });
        this.activity.log('error', 'remote', toPath, message, false);
      }
      return false;
    }
  }

  /**
   * La reprise n'est possible que reconnecté au même SERVEUR.
   *
   * L'identifiant de connexion est unique par session (`user@host:port#n`) :
   * après une reconnexion, le nonce change mais le serveur est le même, et le
   * .charonpart y est toujours. La comparaison porte donc sur la partie
   * stable, avant le `#`.
   */
  canResume(transfer: Transfer): boolean {
    return (
      transfer.status === 'interrupted' &&
      sameServer(this.sftp.connectionId(), transfer.connectionId)
    );
  }

  /** Reprend un transfert interrompu là où le fichier partiel s'était arrêté. */
  async resume(transfer: Transfer): Promise<boolean> {
    if (!this.canResume(transfer)) {
      return false;
    }
    this.patch(transfer.id, { status: 'active', error: null });
    this.activity.log('resume', 'remote', transfer.remotePath);
    const done = await this.run(transfer.id, () =>
      invoke<number>(this.sftp.commandFor(transfer.direction), {
        // La connexion COURANTE : celle du transfert est morte avec sa
        // session, seul le serveur est le même.
        connectionId: this.sftp.connectionId(),
        remotePath: transfer.remotePath,
        localPath: transfer.localPath,
        transferId: transfer.id,
        resume: true,
      }),
    );
    if (done) {
      await (transfer.direction === 'download' ? this.localFs.refresh() : this.sftp.refresh());
    }
    return done;
  }

  /** Demande l'annulation d'un transfert en cours. */
  cancel(id: string): void {
    void invoke('sftp_transfer_cancel', { transferId: id }).catch(() => undefined);
  }

  /** Retire les transferts terminés/interrompus (et leurs partiels locaux). */
  clearFinished(): void {
    for (const transfer of this._transfers()) {
      if (transfer.status === 'interrupted' && transfer.direction === 'download') {
        void invoke('local_remove', {
          path: transfer.localPath + PART_SUFFIX,
          isDir: false,
        }).catch(() => undefined);
      }
    }
    this._transfers.update((list) => list.filter((t) => t.status === 'active'));
  }

  private async start(
    direction: TransferDirection,
    name: string,
    remotePath: string,
    localPath: string,
  ): Promise<boolean> {
    const connectionId = this.sftp.connectionId();
    if (!connectionId) {
      return false;
    }
    if (direction === 'upload' && this.sftp.protection() === 'readonly') {
      this.sftp.reportError(this.t('misc.transfers.readonly'));
      this.activity.log('error', 'remote', remotePath, 'upload : lecture seule', false);
      return false;
    }

    const id = crypto.randomUUID();
    this._transfers.update((list) => [
      {
        id,
        name,
        direction,
        transferred: 0,
        total: 0,
        status: 'active' as const,
        error: null,
        connectionId,
        remotePath,
        localPath,
        startedAt: Date.now(),
        speed: 0,
      },
      ...list,
    ]);

    return this.run(id, () =>
      invoke<number>(this.sftp.commandFor(direction), {
        connectionId,
        remotePath,
        localPath,
        transferId: id,
        resume: false,
      }),
    );
  }

  /**
   * Vérification d'intégrité (idée 04) : compare les empreintes sha256 des
   * deux côtés après un transfert réussi.
   *
   * C'est le serveur qui hache son fichier, par le canal exec : re-télécharger
   * pour hacher localement ne vérifierait que le second téléchargement.
   *
   * Ne bloque rien — le transfert est déjà « terminé », la vérification
   * s'ajoute derrière et met à jour la ligne quand elle aboutit.
   */
  private async verify(id: string): Promise<void> {
    const transfer = this._transfers().find((t) => t.id === id);
    if (!transfer || this.sftp.protocol() !== 'sftp') {
      return;
    }
    if (!this.settings.verifyTransfers()) {
      return;
    }
    if (transfer.transferred > VERIFY_MAX_BYTES) {
      this.patch(id, {
        verify: 'skipped',
        verifyDetail: this.t('misc.transfers.tooBig'),
      });
      return;
    }

    this.patch(id, { verify: 'checking' });
    try {
      // En parallèle : les deux côtés travaillent en même temps.
      const [local, remote] = await Promise.all([
        invoke<string>('local_sha256', { path: transfer.localPath }),
        invoke<string>('sftp_sha256', {
          connectionId: transfer.connectionId,
          path: transfer.remotePath,
        }),
      ]);
      const same = local === remote;
      this.patch(id, { verify: same ? 'ok' : 'mismatch' });
      if (!same) {
        this.activity.log(
          'error',
          'remote',
          transfer.remotePath,
          'empreintes différentes après transfert',
          false,
        );
        this.toasts.error(this.t('misc.transfers.mismatch', { name: transfer.name }), {
          detail: this.t('misc.transfers.mismatchHint'),
        });
      }
    } catch (error) {
      // Un serveur sans sha256sum, un droit de lecture refusé : la
      // vérification n'a pas eu lieu, et c'est dit — jamais un faux « ok ».
      this.patch(id, {
        verify: 'error',
        verifyDetail: typeof error === 'string' ? error : String(error),
      });
    }
  }

  /** Exécute l'opération et traduit le résultat en statut de la file. */
  private async run(id: string, operation: () => Promise<number>): Promise<boolean> {
    const target = () => this._transfers().find((t) => t.id === id);
    try {
      const written = await operation();
      this.patch(id, { status: 'done', transferred: written });
      const transfer = target();
      if (transfer) {
        this.activity.log(transfer.direction === 'remote' ? 'upload' : transfer.direction, 'remote', transfer.remotePath, `${written} octets`);
        void this.verify(id);
      }
      return true;
    } catch (error) {
      const message = typeof error === 'string' ? error : String(error);
      const transfer = target();
      if (message === CANCELLED_TAG) {
        this.patch(id, { status: 'cancelled' });
        if (transfer) {
          this.activity.log('cancel', 'remote', transfer.remotePath);
        }
      } else {
        // Le backend conserve le .charonpart : reprise possible si des
        // octets étaient passés, sinon simple erreur.
        this.patch(id, {
          status: transfer && transfer.transferred > 0 ? 'interrupted' : 'error',
          error: message,
        });
        if (transfer) {
          this.activity.log(transfer.direction === 'remote' ? 'upload' : transfer.direction, 'remote', transfer.remotePath, message, false);
        }
      }
      return false;
    }
  }

  private patch(id: string, changes: Partial<Transfer>): void {
    this._transfers.update((list) => list.map((t) => (t.id === id ? { ...t, ...changes } : t)));
  }

  /** Recharge la file persistée : les transferts actifs à la fermeture
   *  de l'app reviennent en « interrompus ». */
  private load(): Transfer[] {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        return [];
      }
      return (JSON.parse(raw) as Transfer[])
        .filter((t) => t.status === 'active' || t.status === 'interrupted')
        .map((t) => ({ ...t, status: 'interrupted' as const, error: null }));
    } catch {
      return [];
    }
  }
}
