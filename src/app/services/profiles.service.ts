import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { ServerProfile } from '@app/interfaces';

/** Profils de serveurs enregistrés. Les secrets vivent dans le trousseau macOS, côté Rust. */
@Injectable({ providedIn: 'root' })
export class ProfilesService {
  private readonly _profiles = signal<ServerProfile[]>([]);
  private readonly _error = signal<string | null>(null);

  readonly profiles = this._profiles.asReadonly();
  readonly error = this._error.asReadonly();

  async load(): Promise<void> {
    await this.run(async () => {
      this._profiles.set(await invoke<ServerProfile[]>('profiles_list'));
    });
  }

  /** `secret` : chaîne pour l'enregistrer, '' pour l'effacer, null pour ne rien changer. */
  async save(profile: ServerProfile, secret: string | null): Promise<void> {
    await this.run(async () => {
      this._profiles.set(await invoke<ServerProfile[]>('profile_save', { profile, secret }));
    });
  }

  async delete(id: string): Promise<void> {
    await this.run(async () => {
      this._profiles.set(await invoke<ServerProfile[]>('profile_delete', { id }));
    });
  }

  /** Secret du profil depuis le trousseau (null si absent). */
  secret(id: string): Promise<string | null> {
    return invoke<string | null>('profile_secret', { id }).catch(() => null);
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
