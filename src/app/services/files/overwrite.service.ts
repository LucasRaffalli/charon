import { Injectable, signal } from '@angular/core';

import { StatInfo } from '@app/interfaces';
import { DiffLine } from '@app/services/files/diff';

export type OverwriteDecision =
  | 'overwrite'
  | 'cancel'
  | 'overwrite-all'
  | 'skip-all'
  /** Copier à côté sous un nom libre : rien n'est perdu, on tranchera après. */
  | 'keep-both';

/** Comment nommer les deux côtés : l'envoi et le collage n'opposent pas la
 *  même chose. */
export interface OverwriteSides {
  /** Ce qui va être écrasé (« Serveur : version actuelle »). */
  target: string;
  /** Ce qui arrive (« Local : ce que tu envoies »). */
  source: string;
  /** Icônes des deux côtés. */
  targetIcon: 'server' | 'folder';
  sourceIcon: 'monitor' | 'copy';
}

export const UPLOAD_SIDES: OverwriteSides = {
  target: 'Serveur : version actuelle (sera remplacée)',
  source: 'Local : ce que tu envoies',
  targetIcon: 'server',
  sourceIcon: 'monitor',
};

export const PASTE_SIDES: OverwriteSides = {
  target: 'Destination : version actuelle (sera remplacée)',
  source: 'Source : ce que tu colles',
  targetIcon: 'folder',
  sourceIcon: 'copy',
};

export interface OverwriteRequest {
  name: string;
  /** Absent = envoi local → serveur, le cas d'origine. */
  sides?: OverwriteSides;
  /** Pour un lot : « Appliquer à tous » évite dix dialogues identiques. */
  batch?: boolean;
  /**
   * Proposer « Garder les deux ». Vrai pour un collage (on sait fabriquer un
   * nom libre à côté), faux pour un envoi depuis le disque, où la question
   * ne se pose pas dans les mêmes termes.
   */
  canKeepBoth?: boolean;
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
