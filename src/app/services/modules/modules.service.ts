import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { ModuleSummary } from '@app/interfaces';

/**
 * Gestion des modules (extensions tierces) : découverte, activation, ouverture
 * du dossier, suppression. N'exécute AUCUN code de module : ce service ne fait
 * que piloter le backend (fichiers) et exposer l'état à l'UI. L'exécution
 * sandboxée viendra séparément (voir docs/modules.md).
 */
@Injectable({ providedIn: 'root' })
export class ModulesService {
  private readonly _modules = signal<ModuleSummary[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly modules = this._modules.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  async refresh(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      this._modules.set(await invoke<ModuleSummary[]>('modules_list'));
    } catch (error) {
      this._error.set(String(error));
    } finally {
      this._loading.set(false);
    }
  }

  async setEnabled(slug: string, enabled: boolean): Promise<void> {
    await invoke('module_set_enabled', { slug, enabled });
    // Reflet optimiste sans re-scan complet du disque.
    this._modules.update((list) =>
      list.map((m) => (m.slug === slug ? { ...m, enabled } : m)),
    );
  }

  async openFolder(): Promise<void> {
    await invoke('modules_open_folder').catch((error) => this._error.set(String(error)));
  }

  async delete(slug: string): Promise<void> {
    await invoke('module_delete', { slug });
    this._modules.update((list) => list.filter((m) => m.slug !== slug));
  }
}
