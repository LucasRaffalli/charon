import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { Transfer, TransferDirection, TransferProgressEvent } from '@app/interfaces';
import { SftpService } from '@app/services/sftp.service';

/** Balise émise par le backend quand un transfert est annulé. */
const CANCELLED_TAG = 'CHARON_CANCELLED';

/** File de transferts : streaming côté Rust, progression par events Tauri. */
@Injectable({ providedIn: 'root' })
export class TransfersService {
  private readonly sftp = inject(SftpService);
  private readonly _transfers = signal<Transfer[]>([]);

  readonly transfers = this._transfers.asReadonly();
  readonly activeCount = computed(
    () => this._transfers().filter((t) => t.status === 'active').length,
  );

  constructor() {
    void listen<TransferProgressEvent>('transfer:progress', (event) => {
      const { id, transferred, total } = event.payload;
      this.patch(id, { transferred, total });
    });
  }

  /** Télécharge un fichier distant. Résout à true si le transfert a abouti. */
  download(remotePath: string, localPath: string, name: string): Promise<boolean> {
    return this.track('download', name, (id) =>
      invoke<number>(this.sftp.commandFor('download'), {
        connectionId: this.requireConnection(),
        remotePath,
        localPath,
        transferId: id,
      }),
    );
  }

  /** Envoie un fichier local. Résout à true si le transfert a abouti. */
  upload(localPath: string, remotePath: string, name: string): Promise<boolean> {
    return this.track('upload', name, (id) =>
      invoke<number>(this.sftp.commandFor('upload'), {
        connectionId: this.requireConnection(),
        localPath,
        remotePath,
        transferId: id,
      }),
    );
  }

  /** Demande l'annulation d'un transfert en cours. */
  cancel(id: string): void {
    void invoke('sftp_transfer_cancel', { transferId: id }).catch(() => undefined);
  }

  /** Retire les transferts terminés de la liste. */
  clearFinished(): void {
    this._transfers.update((list) => list.filter((t) => t.status === 'active'));
  }

  private async track(
    direction: TransferDirection,
    name: string,
    operation: (id: string) => Promise<number>,
  ): Promise<boolean> {
    const id = crypto.randomUUID();
    this._transfers.update((list) => [
      { id, name, direction, transferred: 0, total: 0, status: 'active', error: null },
      ...list,
    ]);

    try {
      const written = await operation(id);
      this.patch(id, { status: 'done', transferred: written });
      return true;
    } catch (error) {
      const message = typeof error === 'string' ? error : String(error);
      this.patch(
        id,
        message === CANCELLED_TAG ? { status: 'cancelled' } : { status: 'error', error: message },
      );
      return false;
    }
  }

  private requireConnection(): string {
    const id = this.sftp.connectionId();
    if (!id) {
      throw 'Aucune connexion active';
    }
    return id;
  }

  private patch(id: string, changes: Partial<Transfer>): void {
    this._transfers.update((list) => list.map((t) => (t.id === id ? { ...t, ...changes } : t)));
  }
}
