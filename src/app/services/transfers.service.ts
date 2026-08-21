import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { Transfer, TransferDirection, TransferProgressEvent } from '@app/interfaces';
import { ActivityLogService } from '@app/services/activity-log.service';
import { LocalFsService } from '@app/services/local-fs.service';
import { SftpService } from '@app/services/sftp.service';

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
@Injectable({ providedIn: 'root' })
export class TransfersService {
  private readonly sftp = inject(SftpService);
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
      this.patch(id, { transferred, total });
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
      this.sftp.reportError('Serveur en lecture seule — envoi refusé.');
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

  /** Exécute l'opération et traduit le résultat en statut de la file. */
  private async run(id: string, operation: () => Promise<number>): Promise<boolean> {
    const target = () => this._transfers().find((t) => t.id === id);
    try {
      const written = await operation();
      this.patch(id, { status: 'done', transferred: written });
      const transfer = target();
      if (transfer) {
        this.activity.log(transfer.direction, 'remote', transfer.remotePath, `${written} octets`);
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
