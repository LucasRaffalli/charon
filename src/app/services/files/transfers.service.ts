import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { Transfer, TransferDirection, TransferProgressEvent } from '@app/interfaces';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { ToastService } from '@app/services/workspace/toast.service';

/** Balise émise par le backend quand un transfert est annulé. */
const CANCELLED_TAG = 'CHARON_CANCELLED';
/** Suffixe des fichiers partiels côté backend. */
const PART_SUFFIX = '.charonpart';

const STORAGE_KEY = 'charon:transfers';

/**
 * File de transferts : streaming côté Rust, progression par events Tauri.
 * La file est persistée : un transfert coupé (erreur, fermeture de l'app)
 * revient en « interrompu » et peut reprendre là où il s'était arrêté,
 * une fois reconnecté au même serveur.
 */
/**
 * Au-delà, hacher les deux côtés coûte plus longtemps que le transfert
 * lui-même : la vérification est annoncée « ignorée », jamais faite en
 * silence.
 */
const VERIFY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class TransfersService {
  private readonly sftp = inject(SftpService);
  private readonly settings = inject(SettingsService);
  private readonly toasts = inject(ToastService);
  private readonly localFs = inject(LocalFsService);
  private readonly activity = inject(ActivityLogService);
  private readonly _transfers = signal<Transfer[]>(this.load());

  readonly transfers = this._transfers.asReadonly();
  readonly activeCount = computed(
    () => this._transfers().filter((t) => t.status === 'active').length,
  );

  constructor() {
    void listen<TransferProgressEvent>('transfer:progress', (event) => {
      const { id, transferred, total } = event.payload;
      // Le débit se dérive de ce que l'événement porte déjà : la moyenne
      // depuis le départ, plus stable à lire qu'une mesure instantanée qui
      // saute à chaque à-coup du réseau.
      const started = this._transfers().find((t) => t.id === id)?.startedAt;
      const seconds = started ? (Date.now() - started) / 1000 : 0;
      const speed = seconds > 0.5 ? Math.round(transferred / seconds) : 0;
      this.patch(id, { transferred, total, speed });
    });

    effect(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._transfers()));
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

  /** La reprise n'est possible que reconnecté à la connexion d'origine. */
  canResume(transfer: Transfer): boolean {
    return transfer.status === 'interrupted' && this.sftp.connectionId() === transfer.connectionId;
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
        connectionId: transfer.connectionId,
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
      this.sftp.reportError('Serveur en lecture seule : envoi refusé.');
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
        verifyDetail: 'Fichier trop volumineux pour une vérification rapide',
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
        this.toasts.error(`${transfer.name} : les empreintes diffèrent`, {
          detail: 'Le fichier transféré n’est pas identique à la source',
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
        this.activity.log(transfer.direction, 'remote', transfer.remotePath, `${written} octets`);
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
          this.activity.log(transfer.direction, 'remote', transfer.remotePath, message, false);
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
      const raw = localStorage.getItem(STORAGE_KEY);
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
