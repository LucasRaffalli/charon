import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { Button } from '@app/components/button/button';
import { Icon, IconName } from '@app/components/icon/icon';
import { TextField } from '@app/components/text-field/text-field';
import { Toggle } from '@app/components/toggle/toggle';
import { LayoutMode } from '@app/interfaces';
import { SettingsService } from '@app/services/settings.service';
import { THEME_OPTIONS, ThemeService } from '@app/services/theme.service';
import { UpdaterService } from '@app/services/updater.service';

type SettingsTab = 'appearance' | 'files' | 'connection' | 'updates';

interface TabOption {
  id: SettingsTab;
  icon: IconName;
  label: string;
}

interface LayoutOption {
  value: LayoutMode;
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

  protected readonly activeTab = signal<SettingsTab>('appearance');

  protected readonly tabs: readonly TabOption[] = [
    { id: 'appearance', icon: 'palette', label: 'Apparence' },
    { id: 'files', icon: 'folder', label: 'Fichiers' },
    { id: 'connection', icon: 'server', label: 'Connexion' },
    { id: 'updates', icon: 'refresh', label: 'Mises à jour' },
  ];

  /** Pourcentage du téléchargement de mise à jour (0 si taille inconnue). */
  protected downloadPercent(transferred: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  }

  protected readonly themeOptions = THEME_OPTIONS;

  protected readonly layouts: readonly LayoutOption[] = [
    { value: 'bento', icon: 'layout-grid', label: 'Bento' },
    { value: 'classic', icon: 'rows', label: 'Classique' },
  ];

  /** Minutes d'inactivité avant fermeture, bornées à [0 ; 240] (0 = jamais). */
  protected setIdleMinutes(raw: string): void {
    const minutes = Math.max(0, Math.min(240, Math.round(Number(raw)) || 0));
    this.settings.update({ idleMinutes: minutes });
  }

  protected close(): void {
    this.settings.closePanel();
  }
}
