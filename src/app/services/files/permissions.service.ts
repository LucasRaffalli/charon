import { Injectable, inject, signal } from '@angular/core';

import { FileEntry } from '@app/interfaces';

/** Ce que le panneau de permissions est en train de montrer. */
export interface PermissionsRequest {
  entry: FileEntry;
  /** Chemin absolu : c'est lui qui part au chmod, pas le nom. */
  path: string;
}

/**
 * Le panneau de permissions (idée 07), ouvert à la demande depuis le clic
 * droit. Même patron que `OverwriteService` : un signal d'état, un composant
 * qui le rend.
 */
@Injectable({ providedIn: 'root' })
export class PermissionsService {
  private readonly _state = signal<PermissionsRequest | null>(null);
  readonly state = this._state.asReadonly();

  open(entry: FileEntry, path: string): void {
    this._state.set({ entry, path });
  }

  close(): void {
    this._state.set(null);
  }
}
