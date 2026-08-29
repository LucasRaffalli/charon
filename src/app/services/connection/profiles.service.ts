import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

import { Favorite, ServerProfile } from '@app/interfaces';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { windowLabel } from '@app/services/system/window-scope';

/** Profils de serveurs enregistrés. Les secrets vivent dans le trousseau macOS, côté Rust. */
@Injectable({ providedIn: 'root' })
export class ProfilesService {
  private readonly activity = inject(ActivityLogService);
  private readonly toasts = inject(ToastService);

  private readonly _profiles = signal<ServerProfile[]>([]);
  private readonly _error = signal<string | null>(null);

  readonly profiles = this._profiles.asReadonly();
  readonly error = this._error.asReadonly();

  constructor() {
    // Un profil créé, modifié ou supprimé dans une autre fenêtre doit se voir
    // ici : écran de connexion, palette et menus lisent cette liste. Le store
    // backend est la source de vérité, l'événement ne dit que « relis ».
    void listen<{ origin: string }>('flotte:profiles-changed', ({ payload }) => {
      if (payload.origin !== windowLabel()) {
        void this.load();
      }
    });
  }

  /** Prévient les autres fenêtres après une écriture réussie. */
  private announce(): void {
    if (this._error() === null) {
      void emit('flotte:profiles-changed', { origin: windowLabel() }).catch(() => undefined);
    }
  }

  async load(): Promise<void> {
    await this.run(async () => {
      this._profiles.set(await invoke<ServerProfile[]>('profiles_list'));
    });
  }

  /**
   * `secret` : chaîne pour l'enregistrer, '' pour l'effacer, null pour ne rien changer.
   * `migrateSecretFrom` : id d'un ancien profil dont le secret doit être recopié
   * (édition avec changement d'identifiant) : la copie se fait côté Rust.
   */
  async save(
    profile: ServerProfile,
    secret: string | null,
    migrateSecretFrom: string | null = null,
  ): Promise<void> {
    await this.run(async () => {
      this._profiles.set(
        await invoke<ServerProfile[]>('profile_save', { profile, secret, migrateSecretFrom }),
      );
    });
    this.announce();
  }

  /**
   * Pose ou retire le dossier d'arrivée d'un profil.
   *
   * Le secret n'est pas touché : `profile_save` avec un secret nul laisse le
   * trousseau tel quel et relit `hasSecret` du profil enregistré. Ancrer ne
   * doit rien coûter, surtout pas un mot de passe à retaper.
   */
  async setAnchor(id: string, anchor: string | null): Promise<boolean> {
    if (!this._profiles().length) {
      await this.load();
    }
    const profile = this._profiles().find((p) => p.id === id);
    if (profile) {
      await this.save({ ...profile, anchor }, null);
    }
    const done = !!profile && this._error() === null;

    // Le journal et le toast vivent ici, et non chez chaque appelant : ancrer
    // se fait depuis la palette comme depuis le clic droit, et les deux doivent
    // dire exactement la même chose.
    const detail = done
      ? anchor
        ? "Dossier d'arrivée du profil"
        : 'Ancre retirée, arrivée au dossier personnel'
      : (this._error() ?? 'Profil introuvable');
    this.activity.log('anchor', 'remote', anchor ?? id, detail, done);

    if (!done) {
      this.toasts.error("L'ancre n'a pas pu être enregistrée", detail);
    } else if (anchor) {
      // L'effet est pour la prochaine connexion : il n'y a rien à constater
      // tout de suite, donc il faut le dire.
      this.toasts.success('Ancre posée, vous arriverez ici', anchor);
    } else {
      this.toasts.success('Ancre retirée', 'Arrivée au dossier personnel');
    }
    return done;
  }

  /**
   * Les favoris d'un profil. Comme l'ancre, ils passent par `save` avec un
   * secret NUL, ce que le backend traite comme « inchangé » : gérer ses
   * raccourcis ne doit jamais coûter un mot de passe à retaper.
   */
  private async setFavorites(id: string, favorites: Favorite[]): Promise<boolean> {
    if (!this._profiles().length) {
      await this.load();
    }
    const profile = this._profiles().find((p) => p.id === id);
    if (!profile) {
      return false;
    }
    await this.save({ ...profile, favorites }, null);
    return this._error() === null;
  }

  /** Les favoris d'un profil, dans l'ordre où ils ont été posés. */
  favoritesOf(id: string | null): Favorite[] {
    if (!id) {
      return [];
    }
    return this._profiles().find((p) => p.id === id)?.favorites ?? [];
  }

  /** Ajoute un dossier aux favoris. Un chemin déjà présent n'est pas doublé. */
  async addFavorite(id: string, favorite: Favorite): Promise<boolean> {
    const current = this.favoritesOf(id);
    if (current.some((item) => item.path === favorite.path)) {
      return true;
    }
    const done = await this.setFavorites(id, [...current, favorite]);
    this.activity.log('anchor', 'remote', favorite.path, 'ajouté aux favoris', done);
    return done;
  }

  async removeFavorite(id: string, path: string): Promise<boolean> {
    const done = await this.setFavorites(
      id,
      this.favoritesOf(id).filter((item) => item.path !== path),
    );
    this.activity.log('anchor', 'remote', path, 'retiré des favoris', done);
    return done;
  }

  /** Renomme un favori ou lui change d'icône. */
  async updateFavorite(id: string, path: string, patch: Partial<Favorite>): Promise<boolean> {
    return this.setFavorites(
      id,
      this.favoritesOf(id).map((item) => (item.path === path ? { ...item, ...patch } : item)),
    );
  }

  /** Déplace un favori dans la liste (le glissé de réordonnancement). */
  async moveFavorite(id: string, from: number, to: number): Promise<boolean> {
    const list = [...this.favoritesOf(id)];
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) {
      return false;
    }
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    return this.setFavorites(id, list);
  }

  /** L'ancre d'un profil, ou null s'il n'en a pas (ou n'existe pas). */
  anchorOf(id: string | null): string | null {
    if (!id) {
      return null;
    }
    return this._profiles().find((p) => p.id === id)?.anchor ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.run(async () => {
      this._profiles.set(await invoke<ServerProfile[]>('profile_delete', { id }));
    });
    this.announce();
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    this._error.set(null);
    try {
      await operation();
    } catch (error) {
      this._error.set(typeof error === 'string' ? error : String(error));
    }
  }
}
