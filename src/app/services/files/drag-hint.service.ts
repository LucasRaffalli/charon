import { Injectable, signal } from '@angular/core';

/**
 * La cible d'un glissé qui survole un AUTRE panneau serveur (vue côte à
 * côte) : le panneau source la pose pendant le mouvement, le panneau visé la
 * lit pour surligner sa ligne comme si le glissé était le sien. Un signal
 * partagé plutôt qu'une référence directe : les panneaux ne se connaissent
 * pas entre eux.
 */
export interface DragHint {
  /** La session du panneau survolé. */
  sessionId: string;
  /** La ligne de dossier visée sous le curseur, s'il y en a une. */
  dir: string | null;
}

@Injectable({ providedIn: 'root' })
export class DragHintService {
  private readonly _hint = signal<DragHint | null>(null);

  readonly hint = this._hint.asReadonly();

  set(hint: DragHint | null): void {
    this._hint.set(hint);
  }

  clear(): void {
    this._hint.set(null);
  }
}
