import { Injectable, signal } from '@angular/core';

import { Favorite } from '@app/interfaces';

/** Le favori en cours d'édition, et le profil où il vit. */
export interface FavoriteEdit {
  profileId: string;
  /** Le favori tel qu'il est enregistré : son `path` sert de clé au patch. */
  favorite: Favorite;
}

/**
 * La modale d'édition d'un favori. Même patron que `PermissionsService` : un
 * signal d'état, un composant monté une fois qui le rend.
 */
@Injectable({ providedIn: 'root' })
export class FavoriteEditService {
  private readonly _state = signal<FavoriteEdit | null>(null);
  readonly state = this._state.asReadonly();

  open(profileId: string, favorite: Favorite): void {
    this._state.set({ profileId, favorite });
  }

  close(): void {
    this._state.set(null);
  }
}
