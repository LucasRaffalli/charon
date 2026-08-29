import { Injectable, signal } from '@angular/core';

import { Session } from '@app/services/connection/session-registry';

/** Le fichier désigné : sa session, son chemin, son nom. */
export interface ComparedPick {
  session: Session;
  path: string;
  name: string;
}

/**
 * Le mode « sélection » de la comparaison : armé, le PROCHAIN fichier cliqué
 * dans un panneau serveur (n'importe lequel, n'importe quelle session) est
 * livré à l'appelant. On navigue avec le vrai explorateur au lieu d'un
 * sélecteur modal ; Échap annule.
 */
@Injectable({ providedIn: 'root' })
export class ComparePickService {
  private readonly _armed = signal(false);
  readonly armed = this._armed.asReadonly();

  private resolver: ((pick: ComparedPick | null) => void) | null = null;

  // En phase de CAPTURE : Échap doit annuler le mode avant que le raccourci
  // global « vider la sélection » ne l'attrape.
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.settle(null);
    }
  };

  request(): Promise<ComparedPick | null> {
    this.settle(null);
    this._armed.set(true);
    document.addEventListener('keydown', this.onKeydown, true);
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  deliver(pick: ComparedPick): void {
    this.settle(pick);
  }

  settle(pick: ComparedPick | null): void {
    document.removeEventListener('keydown', this.onKeydown, true);
    this._armed.set(false);
    const resolver = this.resolver;
    this.resolver = null;
    resolver?.(pick);
  }
}
