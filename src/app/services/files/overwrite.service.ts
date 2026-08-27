import { Injectable, signal } from '@angular/core';

import { StatInfo } from '@app/interfaces';
import { DiffLine } from '@app/services/files/diff';

export type OverwriteDecision = 'overwrite' | 'cancel';

export interface OverwriteRequest {
  name: string;
  /** La version serveur est-elle plus récente que la copie locale ? */
  remoteNewer: boolean;
  local: StatInfo;
  remote: StatInfo;
  /** Charge le diff à la demande (null si binaire / trop volumineux). */
  loadDiff: () => Promise<DiffLine[] | null>;
}

/**
 * Dialogue « écraser ? » avec aperçu de diff et alerte de conflit, sous forme
 * de promesse (même patron que DialogService). Rendu par OverwriteDialog.
 */
@Injectable({ providedIn: 'root' })
export class OverwriteService {
  private readonly _state = signal<OverwriteRequest | null>(null);
  private resolver: ((decision: OverwriteDecision) => void) | null = null;

  readonly state = this._state.asReadonly();

  request(request: OverwriteRequest): Promise<OverwriteDecision> {
    this.settle('cancel');
    this._state.set(request);
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  settle(decision: OverwriteDecision): void {
    const resolver = this.resolver;
    this.resolver = null;
    this._state.set(null);
    resolver?.(decision);
  }
}
