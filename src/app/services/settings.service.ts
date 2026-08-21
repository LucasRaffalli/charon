import { Injectable, computed, effect, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { Settings } from '@app/interfaces';

const STORAGE_KEY = 'charon:settings';

const DEFAULT_SETTINGS: Settings = {
  layout: 'bento',
  showHidden: false,
  sidebarWidth: 280,
  localPaneHeight: 300,
  idleMinutes: 15,
  bottomPanelOpen: true,
  bottomPanelTab: 'transfers',
};

/** Préférences de l'application, persistées dans le stockage local. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _settings = signal<Settings>(this.load());
  private readonly _panelOpen = signal(false);

  readonly settings = this._settings.asReadonly();
  readonly panelOpen = this._panelOpen.asReadonly();

  readonly layout = computed(() => this._settings().layout);
  readonly showHidden = computed(() => this._settings().showHidden);
  readonly sidebarWidth = computed(() => this._settings().sidebarWidth);
  readonly localPaneHeight = computed(() => this._settings().localPaneHeight);
  readonly idleMinutes = computed(() => this._settings().idleMinutes);
  readonly bottomPanelOpen = computed(() => this._settings().bottomPanelOpen);
  readonly bottomPanelTab = computed(() => this._settings().bottomPanelTab);

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
      return raw
        ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
        : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}
