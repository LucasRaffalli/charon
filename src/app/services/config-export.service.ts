import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { AppearanceService } from '@app/services/appearance.service';
import { DockService } from '@app/services/dock.service';
import { ProfilesService } from '@app/services/profiles.service';
import { SettingsService } from '@app/services/settings.service';
import { ThemeService } from '@app/services/theme.service';
import { UpdaterService } from '@app/services/updater.service';

/** Version du format d'export, pour qu'une future relecture sache quoi lire. */
const FORMAT = 1;

export type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string };

const stamp = (): string => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/**
 * Export de la configuration : tout ce que l'utilisateur peut régler, et rien
 * d'autre.
 *
 * **Aucun secret n'en fait partie**, par construction autant que par choix :
 * les mots de passe et les passphrases vivent dans le trousseau du système et
 * aucune commande ne les renvoie à la WebView. Un profil exporté ne porte donc
 * que ses coordonnées et un drapeau `hasSecret`, qui dit qu'un secret existe
 * sans rien en révéler : de quoi savoir, à la relecture, quels profils
 * redemanderont leur mot de passe.
 */
@Injectable({ providedIn: 'root' })
export class ConfigExportService {
  private readonly theme = inject(ThemeService);
  private readonly appearance = inject(AppearanceService);
  private readonly dock = inject(DockService);
  private readonly settings = inject(SettingsService);
  private readonly profiles = inject(ProfilesService);
  private readonly updater = inject(UpdaterService);

  private readonly _status = signal<ExportStatus>({ kind: 'idle' });
  readonly status = this._status.asReadonly();

  // Signaux dérivés : le gabarit d'Angular ne réduit pas une union
  // discriminée, autant lui donner des valeurs déjà décidées.
  readonly working = computed(() => this._status().kind === 'working');
  readonly exportedPath = computed(() => {
    const status = this._status();
    return status.kind === 'done' ? status.path : null;
  });
  readonly exportError = computed(() => {
    const status = this._status();
    return status.kind === 'error' ? status.message : null;
  });

  /** Ce que contiendra le fichier. Sorti à part pour rester lisible et testable. */
  payload(): Record<string, unknown> {
    return {
      app: 'Charon',
      format: FORMAT,
      version: this.updater.currentVersion(),
      exportedAt: new Date().toISOString(),
      apparence: {
        theme: this.theme.theme(),
        accent: this.theme.accent(),
        ...this.appearance.appearance(),
      },
      disposition: this.dock.tree(),
      reglages: this.settings.settings(),
      // Les profils sont déjà dépourvus de secret : le trousseau garde les
      // mots de passe, `hasSecret` dit seulement qu'il y en a un.
      profils: this.profiles.profiles(),
    };
  }

  async run(): Promise<void> {
    this._status.set({ kind: 'working' });
    try {
      const path = await invoke<string>('local_export_config', {
        fileName: `charon-reglages-${stamp()}.json`,
        contents: JSON.stringify(this.payload(), null, 2),
      });
      this._status.set({ kind: 'done', path });
    } catch (error) {
      this._status.set({ kind: 'error', message: String(error) });
    }
  }

  reset(): void {
    this._status.set({ kind: 'idle' });
  }
}
