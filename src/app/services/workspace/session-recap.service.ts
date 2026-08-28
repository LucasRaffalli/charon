import { Injectable, signal } from '@angular/core';

import { ActivityKind } from '@app/interfaces';

/** Une ligne du bilan : ce qui a été fait, combien de fois, et où. */
export interface RecapLine {
  kind: ActivityKind | 'transfer';
  text: string;
  /** La cible la plus récente : de quoi situer sans tout lister. */
  where: string;
  /** Couleur de la pastille : la nature se lit avant le texte. */
  tone: 'ok' | 'accent' | 'warn' | 'err';
}

export interface RecapRequest {
  host: string;
  /** `sftp://user@host`, tel qu'affiché sous le titre. */
  address: string;
  prod: boolean;
  lines: RecapLine[];
}

/**
 * Le bilan de session (idée 06), montré au moment de débarquer.
 *
 * Sous forme de promesse, comme les autres dialogues : l'appelant attend la
 * décision plutôt que de gérer un rappel.
 */
@Injectable({ providedIn: 'root' })
export class SessionRecapService {
  private readonly _state = signal<RecapRequest | null>(null);
  private resolver: ((leave: boolean) => void) | null = null;

  readonly state = this._state.asReadonly();

  ask(request: RecapRequest): Promise<boolean> {
    this.settle(false);
    this._state.set(request);
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  settle(leave: boolean): void {
    const resolver = this.resolver;
    this.resolver = null;
    this._state.set(null);
    resolver?.(leave);
  }
}
