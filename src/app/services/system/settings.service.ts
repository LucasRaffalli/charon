import { Injectable, computed, effect, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { Settings } from '@app/interfaces';

const STORAGE_KEY = 'charon:settings';

const DEFAULT_SETTINGS: Settings = {
  showHidden: false,
  verifyTransfers: false,
  formatOnSave: true,
  askDownloadDir: false,
  trashDays: 7,
  idleMinutes: 15,
  editorApp: '',
  localHome: '',
  lang: 'fr',
};

/** Préférences de l'application, persistées dans le stockage local. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly _settings = signal<Settings>(this.load());
  private readonly _panelOpen = signal(false);

  readonly settings = this._settings.asReadonly();
  readonly panelOpen = this._panelOpen.asReadonly();

  readonly showHidden = computed(() => this._settings().showHidden);
  readonly verifyTransfers = computed(() => this._settings().verifyTransfers);
  readonly formatOnSave = computed(() => this._settings().formatOnSave);
  readonly askDownloadDir = computed(() => this._settings().askDownloadDir);
  readonly trashDays = computed(() => this._settings().trashDays);
  readonly idleMinutes = computed(() => this._settings().idleMinutes);
  readonly editorApp = computed(() => this._settings().editorApp);
  readonly localHome = computed(() => this._settings().localHome);
  readonly lang = computed(() => this._settings().lang);

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

  /** Une autre fenêtre a changé les réglages : on relit, et on ne pose que
   *  si quelque chose diffère vraiment (sinon l'écho entre fenêtres
   *  rebondirait sans fin sur des objets égaux mais jamais identiques). */
  reloadFromStorage(): void {
    const stored = this.load();
    if (JSON.stringify(stored) !== JSON.stringify(this._settings())) {
      this._settings.set(stored);
    }
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
        verifyTransfers: parsed.verifyTransfers ?? DEFAULT_SETTINGS.verifyTransfers,
        formatOnSave: parsed.formatOnSave ?? DEFAULT_SETTINGS.formatOnSave,
        askDownloadDir: parsed.askDownloadDir ?? DEFAULT_SETTINGS.askDownloadDir,
        // Borné à l'année : une corbeille qu'on ne purge jamais se règle
        // avec 0, pas avec un nombre de jours absurde.
        trashDays: Math.min(365, Math.max(0, parsed.trashDays ?? DEFAULT_SETTINGS.trashDays)),
        idleMinutes: parsed.idleMinutes ?? DEFAULT_SETTINGS.idleMinutes,
        editorApp: parsed.editorApp ?? DEFAULT_SETTINGS.editorApp,
        localHome: parsed.localHome ?? DEFAULT_SETTINGS.localHome,
        // Une langue inconnue (réglage bricolé à la main, version future
        // relue par une plus ancienne) retombe sur la source.
        lang: parsed.lang === 'en' ? 'en' : DEFAULT_SETTINGS.lang,
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}
