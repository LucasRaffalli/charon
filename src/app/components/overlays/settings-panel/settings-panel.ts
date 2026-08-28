import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { ShortcutsList } from '@app/components/panels/shortcuts-list/shortcuts-list';
import { Icon, IconName } from '@app/components/ui/icon/icon';
import { TextField } from '@app/components/ui/text-field/text-field';
import { Toggle } from '@app/components/ui/toggle/toggle';
import changelogData from '../../../../assets/changelog.json';

import { ChangelogEntry } from '@app/interfaces';
import { ConfigExportService } from '@app/services/system/config-export.service';
import { DesignService } from '@app/services/appearance/design.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { DockService } from '@app/services/workspace/dock.service';
import { ModulesService } from '@app/services/modules/modules.service';
import { SettingsService } from '@app/services/system/settings.service';
import { THEME_OPTIONS, ThemeService } from '@app/services/appearance/theme.service';
import { UpdaterService } from '@app/services/system/updater.service';

type SettingsTab =
  | 'design'
  | 'files'
  | 'connection'
  | 'shortcuts'
  | 'data'
  | 'modules'
  | 'updates';

interface TabOption {
  id: SettingsTab;
  icon: IconName;
  label: string;
}

@Component({
  selector: 'app-settings-panel',
  imports: [Button, Icon, ShortcutsList, TextField, Toggle],
  templateUrl: './settings-panel.html',
  styleUrl: './settings-panel.scss',
  host: {
    '(document:keydown.escape)': 'close()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPanel {
  protected readonly settings = inject(SettingsService);
  protected readonly themeService = inject(ThemeService);
  protected readonly updater = inject(UpdaterService);
  protected readonly dock = inject(DockService);
  protected readonly modules = inject(ModulesService);
  protected readonly exporter = inject(ConfigExportService);
  private readonly dialog = inject(DialogService);
  private readonly design = inject(DesignService);

  protected readonly activeTab = signal<SettingsTab>('files');

  /** Changelog curaté (src/assets/changelog.json), rédigé à chaque feature. */
  // Le JSON importé donne `kind: string` : le cast dit ce que le fichier
  // contient vraiment. Il est dans le dépôt, donc vérifié à la relecture, et le
  // CSS a de toute façon une puce de repli si une nature inconnue s'y glissait.
  protected readonly changelog = changelogData as ChangelogEntry[];

  protected readonly tabs: readonly TabOption[] = [
    { id: 'design', icon: 'palette', label: 'Design' },
    { id: 'files', icon: 'folder', label: 'Fichiers' },
    { id: 'connection', icon: 'server', label: 'Connexion' },
    { id: 'shortcuts', icon: 'command', label: 'Raccourcis' },
    { id: 'data', icon: 'file', label: 'Données' },
    { id: 'modules', icon: 'layout-grid', label: 'Modules' },
    { id: 'updates', icon: 'refresh', label: 'Mises à jour' },
  ];

  /** Titre de la section affichée (en-tête du contenu). */
  protected readonly activeLabel = computed(
    () => this.tabs.find((tab) => tab.id === this.activeTab())?.label ?? '',
  );

  constructor() {
    // (Re)scanne les modules à l'ouverture de leur onglet.
    effect(() => {
      if (this.settings.panelOpen() && this.activeTab() === 'modules') {
        void this.modules.refresh();
      }
    });
  }

  protected async toggleModule(slug: string, enabled: boolean): Promise<void> {
    await this.modules.setEnabled(slug, enabled);
  }

  /** Supprime un module après confirmation renforcée (nom exact à retaper). */
  protected async deleteModule(slug: string, name: string): Promise<void> {
    const typed = (
      await this.dialog.prompt({
        title: `Supprimer le module « ${name} » ?`,
        message: `Le dossier du module sera supprimé définitivement. Tape « ${name} » pour confirmer.`,
        placeholder: name,
        confirmLabel: 'Supprimer',
        danger: true,
      })
    )?.trim();
    if (typed === name) {
      await this.modules.delete(slug);
    }
  }

  protected readonly themeOptions = THEME_OPTIONS;

  /** Les accents listés. Un secret n'apparaît que tant qu'il est sélectionné. */
  protected readonly accentOptions = this.themeService.visibleAccents;

  /** Une opération de mise à jour est en cours : relancer n'aurait pas de sens. */
  protected readonly updateBusy = computed(() => {
    const kind = this.updater.status().kind;
    return kind === 'checking' || kind === 'downloading' || kind === 'ready';
  });

  /** Pourcentage du téléchargement de mise à jour (0 si taille inconnue). */
  protected downloadPercent(transferred: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  }

  /** Minutes d'inactivité avant fermeture, bornées à [0 ; 240] (0 = jamais). */
  /** Bornes du champ : le service borne aussi à la relecture du stockage. */
  protected setTrashDays(value: string): void {
    const days = Number.parseInt(value, 10);
    this.settings.update({ trashDays: Number.isFinite(days) ? Math.min(365, Math.max(0, days)) : 0 });
  }

  protected setIdleMinutes(raw: string): void {
    const minutes = Math.max(0, Math.min(240, Math.round(Number(raw)) || 0));
    this.settings.update({ idleMinutes: minutes });
  }

  /**
   * « Design » ne remplit pas la modale : il la referme et rend l'application
   * visible, pour qu'on règle en voyant le résultat sur la vraie interface.
   */
  protected selectTab(id: SettingsTab): void {
    if (id === 'design') {
      this.settings.closePanel();
      this.design.start();
      return;
    }
    this.activeTab.set(id);
  }

  protected close(): void {
    this.settings.closePanel();
  }
}
