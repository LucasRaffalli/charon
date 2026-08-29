import { Injectable, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';

import { ModuleSummary } from '@app/interfaces';
import { windowLabel } from '@app/services/system/window-scope';

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

  constructor() {
    // Activer un module dans les réglages d'une fenêtre secondaire doit
    // atteindre `main`, seule fenêtre où les Workers tournent : son
    // ModuleHostService réconcilie sur modules(), il suffit de relire.
    void listen<{ origin: string }>('flotte:modules-changed', ({ payload }) => {
      if (payload.origin !== windowLabel()) {
        void this.refresh();
      }
    });
  }

  private announce(): void {
    void emit('flotte:modules-changed', { origin: windowLabel() }).catch(() => undefined);
  }

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
    this.announce();
  }

  async openFolder(): Promise<void> {
    await invoke('modules_open_folder').catch((error) => this._error.set(String(error)));
  }

  async delete(slug: string): Promise<void> {
    await invoke('module_delete', { slug });
    this._modules.update((list) => list.filter((m) => m.slug !== slug));
    this.announce();
  }
}
