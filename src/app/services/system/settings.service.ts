import { Injectable, computed, effect, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { Settings } from '@app/interfaces';

const STORAGE_KEY = 'charon:settings';

const DEFAULT_SETTINGS: Settings = {
  showHidden: false,
  idleMinutes: 15,
  editorApp: '',
};

/** Préférences de l'application, persistées dans le stockage local. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _settings = signal<Settings>(this.load());
  private readonly _panelOpen = signal(false);

  readonly settings = this._settings.asReadonly();
  readonly panelOpen = this._panelOpen.asReadonly();

  readonly showHidden = computed(() => this._settings().showHidden);
  readonly idleMinutes = computed(() => this._settings().idleMinutes);
  readonly editorApp = computed(() => this._settings().editorApp);

  constructor() {
    effect(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings()));
    });

    // Le backend applique le délai d'inactivité courant (au démarrage
    // et à chaque changement).
    effect(() => {
      void invoke('set_idle_timeout', { minutes: this.idleMinutes() }).catch(() => undefined);
    });
  }

  update(patch: Partial<Settings>): void {
    this._settings.update((current) => ({ ...current, ...patch }));
  }

  openPanel(): void {
    this._panelOpen.set(true);
  }

  closePanel(): void {
    this._panelOpen.set(false);
  }

  private load(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return DEFAULT_SETTINGS;
      }
      const parsed = JSON.parse(raw) as Partial<Settings>;
      // Ne reprend que les clés connues (purge les réglages disparus).
      return {
        showHidden: parsed.showHidden ?? DEFAULT_SETTINGS.showHidden,
        idleMinutes: parsed.idleMinutes ?? DEFAULT_SETTINGS.idleMinutes,
        editorApp: parsed.editorApp ?? DEFAULT_SETTINGS.editorApp,
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}
