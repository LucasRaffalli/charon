import { Injectable, computed, signal } from '@angular/core';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { Update, check } from '@tauri-apps/plugin-updater';

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; transferred: number; total: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

/** Premier check auto après le lancement (laisse l'app démarrer tranquille). */
const AUTO_CHECK_DELAY_MS = 5_000;
/** Re-check périodique tant que l'app tourne. */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Mises à jour signées via tauri-plugin-updater : la vérification et le
 * téléchargement se font côté Rust, la signature est contrôlée avec la clé
 * publique embarquée dans tauri.conf.json avant toute installation.
 *
 * La vérification est **automatique** (au démarrage puis toutes les 6 h,
 * silencieuse : une erreur réseau ne dérange personne) ; le bouton des
 * réglages reste disponible pour un check manuel, dont les erreurs sont
 * affichées. `updateAvailable` alimente les indicateurs visuels (pastille
 * sur l'engrenage, badge dans les réglages).
 */
@Injectable({ providedIn: 'root' })
export class UpdaterService {
  private readonly _status = signal<UpdateStatus>({ kind: 'idle' });
  private readonly _currentVersion = signal('…');
  /** Notes de version (changelog) de la mise à jour disponible. */
  private readonly _notes = signal<string | null>(null);
  private update: Update | null = null;

  readonly status = this._status.asReadonly();
  readonly currentVersion = this._currentVersion.asReadonly();
  readonly notes = this._notes.asReadonly();

  /** Une mise à jour attend l'utilisateur (pastille/badge). */
  readonly updateAvailable = computed(() => {
    const kind = this._status().kind;
    return kind === 'available' || kind === 'downloading' || kind === 'ready';
  });

  constructor() {
    void getVersion()
      .then((version) => this._currentVersion.set(version))
      .catch(() => this._currentVersion.set('?'));

    // Check auto : au démarrage (différé) puis périodique. Service instancié
    // dès le lancement via app.ts.
    setTimeout(() => void this.checkForUpdates(true), AUTO_CHECK_DELAY_MS);
    setInterval(() => void this.checkForUpdates(true), AUTO_CHECK_INTERVAL_MS);
  }

  /**
   * Vérifie si une mise à jour existe. En mode `silent` (checks auto), une
   * erreur ne change pas l'état affiché et un téléchargement en cours n'est
   * jamais interrompu.
   */
  async checkForUpdates(silent = false): Promise<void> {
    const current = this._status().kind;
    if (current === 'checking' || current === 'downloading' || current === 'ready') {
      return;
    }
    if (!silent) {
      this._status.set({ kind: 'checking' });
    }
    try {
      this.update = await check();
      if (this.update) {
        this._notes.set(this.update.body?.trim() || null);
        this._status.set({ kind: 'available', version: this.update.version });
      } else {
        this._notes.set(null);
        if (!silent) {
          this._status.set({ kind: 'upToDate' });
        }
      }
    } catch (error) {
      if (!silent) {
        this._status.set({ kind: 'error', message: `Vérification impossible : ${String(error)}` });
      }
    }
  }

  /** Télécharge, vérifie la signature, installe puis relance l'application. */
  async install(): Promise<void> {
    const update = this.update;
    if (!update) {
      return;
    }
    let total = 0;
    let transferred = 0;
    this._status.set({ kind: 'downloading', transferred, total });
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            transferred += event.data.chunkLength;
            this._status.set({ kind: 'downloading', transferred, total });
            break;
          case 'Finished':
            this._status.set({ kind: 'ready' });
            break;
        }
      });
      this._status.set({ kind: 'ready' });
      await relaunch();
    } catch (error) {
      this._status.set({ kind: 'error', message: `Installation impossible : ${String(error)}` });
    }
  }
}
