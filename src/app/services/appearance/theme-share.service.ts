import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { Appearance, isAccent, parseAppearance } from '@app/interfaces';
import { AppearanceService } from '@app/services/appearance/appearance.service';
import { CustomThemeService, THEME_TOKENS } from '@app/services/appearance/custom-theme.service';
import { ThemeService } from '@app/services/appearance/theme.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { injectT } from '@app/lang/i18n.service';

/** Version du format d'un thème partagé. */
const FORMAT = 1;

/**
 * Ce qu'un fichier de thème contient. Volontairement REDUIT à l'apparence :
 * ni profils, ni réglages, ni disposition. On partage un thème, pas sa
 * configuration — et surtout on ne fait pas voyager par mégarde la liste des
 * serveurs de quelqu'un dans un fichier qu'il envoie sur un Slack.
 */
interface ThemeFile {
  app: 'Charon';
  kind: 'theme';
  format: number;
  name: string;
  /** Le thème de base sur lequel le calque a été fabriqué. */
  base: string;
  accent: string;
  /** Les jetons du calque, s'il y en a un. */
  tokens: Record<string, string> | null;
  /** Le décor : dégradé, panneaux, rayon, texte, filigrane. */
  appearance: Appearance;
}

export type ShareStatus = { kind: 'idle' } | { kind: 'working' } | { kind: 'done'; path: string } | { kind: 'error'; message: string };

/**
 * Exporter et importer un thème, pour le partager.
 *
 * Le fichier est autonome : il porte le calque de couleurs, l'accent, le
 * thème de base et tout le décor, image de filigrane comprise (elle est déjà
 * en data-URI, elle voyage donc avec). Quelqu'un qui le reçoit l'importe et
 * voit exactement le même Charon.
 */
@Injectable({ providedIn: 'root' })
export class ThemeShareService {
  private readonly theme = inject(ThemeService);
  private readonly appearance = inject(AppearanceService);
  private readonly custom = inject(CustomThemeService);
  private readonly toasts = inject(ToastService);
  private readonly t = injectT();

  private readonly _status = signal<ShareStatus>({ kind: 'idle' });
  readonly status = this._status.asReadonly();
  readonly working = computed(() => this._status().kind === 'working');
  readonly exportedPath = computed(() => {
    const status = this._status();
    return status.kind === 'done' ? status.path : null;
  });

  /** Écrit le thème dans les Téléchargements, sous un nom donné. */
  async exportTheme(name: string): Promise<void> {
    this._status.set({ kind: 'working' });
    const file: ThemeFile = {
      app: 'Charon',
      kind: 'theme',
      format: FORMAT,
      name: name.trim() || 'sans-nom',
      base: this.theme.theme(),
      accent: this.theme.accent(),
      tokens: this.custom.custom()?.tokens ?? null,
      appearance: this.appearance.appearance(),
    };
    try {
      const path = await invoke<string>('local_export_config', {
        fileName: `charon-theme-${slug(file.name)}.json`,
        contents: JSON.stringify(file, null, 2),
      });
      this._status.set({ kind: 'done', path });
      this.toasts.success(this.t('design.shareDone'), { detail: path, key: 'theme-share' });
    } catch (error) {
      this._status.set({ kind: 'error', message: String(error) });
      this.toasts.error(this.t('design.shareFailed'), { detail: String(error) });
    }
  }

  /**
   * Applique un thème lu dans un fichier.
   *
   * Tout est revalidé : un fichier partagé vient de quelqu'un d'autre, il a pu
   * être écrit à la main, tronqué, ou produit par une version plus récente.
   * `parseAppearance` borne déjà les valeurs numériques et écarte l'inconnu ;
   * les jetons sont filtrés sur la liste que cette version sait poser.
   */
  async importFile(file: File): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      this.toasts.error(this.t('design.importFailed'));
      return false;
    }
    const raw = parsed as Partial<ThemeFile>;
    if (raw?.app !== 'Charon' || raw.kind !== 'theme') {
      this.toasts.error(this.t('design.importFailed'), {
        detail: this.t('design.importNotTheme'),
      });
      return false;
    }

    if (isThemeName(raw.base)) {
      this.theme.select(raw.base);
    }
    if (typeof raw.accent === 'string' && isAccent(raw.accent)) {
      this.theme.restoreAccent(raw.accent);
    }
    this.appearance.set(parseAppearance(raw.appearance));

    // Les jetons : seulement ceux que cette version connaît, et seulement des
    // couleurs. Un fichier trafiqué ne doit pas pouvoir poser une valeur CSS
    // arbitraire dans le style de la racine.
    const tokens: Record<string, string> = {};
    for (const token of THEME_TOKENS) {
      const value = raw.tokens?.[token.name];
      if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) {
        tokens[token.name] = value;
      }
    }
    this.custom.set(Object.keys(tokens).length ? { tokens } : null);

    this.toasts.success(this.t('design.importDone'), { detail: raw.name ?? '' });
    return true;
  }

  reset(): void {
    this._status.set({ kind: 'idle' });
  }
}

const isThemeName = (value: unknown): value is 'light' | 'dark' | 'contrast' => value === 'light' || value === 'dark' || value === 'contrast';

/** Un nom de fichier sûr : le backend refuse déjà le reste, autant ne pas
 *  lui envoyer n'importe quoi. */
const slug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'sans-nom';
