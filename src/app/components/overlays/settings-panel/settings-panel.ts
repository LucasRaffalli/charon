import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { Icon, IconName } from '@app/components/ui/icon/icon';
import { TextField } from '@app/components/ui/text-field/text-field';
import { Toggle } from '@app/components/ui/toggle/toggle';
import { DockService } from '@app/services/dock.service';
import { SettingsService } from '@app/services/settings.service';
import { THEME_OPTIONS, ThemeService } from '@app/services/theme.service';
import { UpdaterService } from '@app/services/updater.service';

type SettingsTab = 'appearance' | 'files' | 'connection' | 'updates';

interface TabOption {
  id: SettingsTab;
  icon: IconName;
  label: string;
}

@Component({
  selector: 'app-settings-panel',
  imports: [Button, Icon, TextField, Toggle],
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

  protected readonly activeTab = signal<SettingsTab>('appearance');

  protected readonly tabs: readonly TabOption[] = [
    { id: 'appearance', icon: 'palette', label: 'Apparence' },
    { id: 'files', icon: 'folder', label: 'Fichiers' },
    { id: 'connection', icon: 'server', label: 'Connexion' },
    { id: 'updates', icon: 'refresh', label: 'Mises à jour' },
  ];

  /** Titre de la section affichée (en-tête du contenu). */
  protected readonly activeLabel = computed(
    () => this.tabs.find((tab) => tab.id === this.activeTab())?.label ?? '',
  );

  protected readonly themeOptions = THEME_OPTIONS;

  /** Pourcentage du téléchargement de mise à jour (0 si taille inconnue). */
  protected downloadPercent(transferred: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  }

  /** Minutes d'inactivité avant fermeture, bornées à [0 ; 240] (0 = jamais). */
  protected setIdleMinutes(raw: string): void {
    const minutes = Math.max(0, Math.min(240, Math.round(Number(raw)) || 0));
    this.settings.update({ idleMinutes: minutes });
  }

  protected close(): void {
    this.settings.closePanel();
  }
}
