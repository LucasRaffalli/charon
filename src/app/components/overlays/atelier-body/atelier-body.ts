import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { DEFAULT_APPEARANCE, MarkMode } from '@app/interfaces';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { AppearanceService } from '@app/services/appearance/appearance.service';
import {
  CustomThemeService,
  THEME_TOKENS,
  TOKEN_GROUPS,
  ThemeToken,
} from '@app/services/appearance/custom-theme.service';
import { ThemeShareService } from '@app/services/appearance/theme-share.service';
import { readWatermark } from '@app/services/appearance/watermark-image';
import { injectT } from '@app/lang/i18n.service';

/**
 * Le corps de l'atelier : les jetons du thème, le filigrane, le partage.
 *
 * Composant à part et non un morceau de `DesignPanel` : la carte du design
 * dépassait le budget de styles du projet, et la règle maison est
 * d'EXTRAIRE plutôt que de relever le budget (voir la refonte de l'écran de
 * connexion). L'atelier s'y prêtait le mieux : c'est un contenu autonome,
 * derrière un code, que la carte se contente d'héberger.
 */
@Component({
  selector: 'app-atelier-body',
  imports: [SegmentedControl],
  templateUrl: './atelier-body.html',
  styleUrl: './atelier-body.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AtelierBody {
  protected readonly t = injectT();
  protected readonly appearance = inject(AppearanceService);
  protected readonly custom = inject(CustomThemeService);
  protected readonly share = inject(ThemeShareService);

  protected readonly tokenGroups = TOKEN_GROUPS;

  /** L'onglet de l'atelier : les couleurs, ou le filigrane. */
  protected readonly tab = signal<'colors' | 'mark'>('colors');

  /** Le dernier fichier choisi n'était pas une image lisible. */
  protected readonly markError = signal(false);

  /** Le nom sous lequel le thème s'exporte, et le nom du fichier. */
  protected readonly themeName = signal('');

  protected readonly markModeOptions: readonly SegmentedOption[] = [
    { value: 'image', label: this.t('design.markModeImage') },
    { value: 'silhouette', label: this.t('design.markModeSilhouette') },
  ];

  protected tokensOf(group: ThemeToken['group']): readonly ThemeToken[] {
    return THEME_TOKENS.filter((token) => token.group === group);
  }

  protected tokenValue(name: string): string {
    return this.custom.custom()?.tokens[name] ?? '#000000';
  }

  protected setToken(name: string, event: Event): void {
    this.custom.setToken(name, (event.target as HTMLInputElement).value);
  }

  /** L'aperçu de la vignette : l'image choisie, ou le glyphe de Charon. */
  protected readonly previewImage = computed(() => {
    const image = this.appearance.markImage();
    return image ? `url("${image}")` : 'var(--charon-mark)';
  });

  /** La teinte n'a de sens que sur une silhouette : une image affichée telle
   *  quelle garde ses couleurs. */
  protected readonly tintable = computed(
    () => !this.appearance.markImage() || this.appearance.markMode() === 'silhouette',
  );

  /**
   * Choisir l'image du filigrane.
   *
   * Un `<input type="file">` créé à la volée plutôt que le sélecteur natif de
   * Tauri : on veut le CONTENU du fichier, pas son chemin (la CSP n'autorise
   * que `data:`), et le navigateur le donne directement. Aucune permission
   * supplémentaire, aucun aller-retour par le backend.
   */
  protected pickMark(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      const read = await readWatermark(file);
      this.markError.set(read === null);
      if (read) {
        // Le mode IMAGE d'office : qui choisit une image veut la voir, pas
        // en voir la silhouette remplie d'un aplat.
        //
        // Et la PREMIÈRE image relève l'opacité si elle est restée au
        // défaut : 6 % convient à un glyphe monochrome, une photo y est
        // quasi invisible et on croirait que rien ne s'est passé. Une
        // opacité déjà réglée à la main n'est pas touchée.
        const first = !this.appearance.markImage();
        const faint = this.appearance.markOpacity() === DEFAULT_APPEARANCE.markOpacity;
        this.appearance.update({
          markImage: read.dataUrl,
          markMode: 'image',
          ...(first && faint ? { markOpacity: 14 } : {}),
        });
      }
    };
    input.click();
  }

  /** Rendre le glyphe de Charon : le filigrane d'origine. */
  protected clearMarkImage(): void {
    this.markError.set(false);
    this.appearance.update({ markImage: null });
  }

  protected setMarkMode(value: string): void {
    this.appearance.update({ markMode: value as MarkMode });
  }

  protected setMark(key: 'markOpacity' | 'markSize', event: Event): void {
    const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
    if (Number.isFinite(value)) {
      this.appearance.update({ [key]: value });
    }
  }

  /** La teinte affichée : celle posée, ou la couleur de texte courante. */
  protected markColor(): string {
    const chosen = this.appearance.markColor();
    if (chosen) {
      return chosen;
    }
    const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
    return text.startsWith('#') ? text : '#ffffff';
  }

  protected setMarkColor(event: Event): void {
    this.appearance.update({ markColor: (event.target as HTMLInputElement).value });
  }

  /** Rendre la teinte au texte : le filigrane suit de nouveau le thème. */
  protected clearMarkColor(): void {
    this.appearance.update({ markColor: null });
  }

  protected exportTheme(): void {
    void this.share.exportTheme(this.themeName());
  }

  /**
   * Importer un thème. Même mécanique que l'image du filigrane : un champ de
   * fichier créé à la volée, parce qu'on veut le CONTENU et pas un chemin.
   */
  protected importTheme(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        await this.share.importFile(file);
      }
    };
    input.click();
  }
}
