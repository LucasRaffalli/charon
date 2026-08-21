import { Injectable, signal } from '@angular/core';
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

/**
 * Mises à jour signées via tauri-plugin-updater : la vérification et le
 * téléchargement se font côté Rust, la signature est contrôlée avec la clé
 * publique embarquée dans tauri.conf.json avant toute installation.
 */
@Injectable({ providedIn: 'root' })
export class UpdaterService {
  private readonly _status = signal<UpdateStatus>({ kind: 'idle' });
  private readonly _currentVersion = signal('…');
  private update: Update | null = null;

  readonly status = this._status.asReadonly();
  readonly currentVersion = this._currentVersion.asReadonly();

  constructor() {
    void getVersion()
      .then((version) => this._currentVersion.set(version))
      .catch(() => this._currentVersion.set('?'));
  }

  async checkForUpdates(): Promise<void> {
    this._status.set({ kind: 'checking' });
    try {
      this.update = await check();
      this._status.set(
        this.update
          ? { kind: 'available', version: this.update.version }
          : { kind: 'upToDate' },
      );
    } catch (error) {
      this._status.set({ kind: 'error', message: `Vérification impossible : ${String(error)}` });
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
