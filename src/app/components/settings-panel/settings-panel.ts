import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { Icon, IconName } from '@app/components/icon/icon';
import { THEME_OPTIONS } from '@app/components/theme-switcher/theme-switcher';
import { Toggle } from '@app/components/toggle/toggle';
import { LayoutMode } from '@app/interfaces';
import { SettingsService } from '@app/services/settings.service';
import { ThemeService } from '@app/services/theme.service';

type SettingsTab = 'appearance' | 'files';

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
  imports: [Icon, Toggle],
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

  protected readonly activeTab = signal<SettingsTab>('appearance');

  protected readonly tabs: readonly TabOption[] = [
    { id: 'appearance', icon: 'palette', label: 'Apparence' },
    { id: 'files', icon: 'folder', label: 'Fichiers' },
  ];

  protected readonly themeOptions = THEME_OPTIONS;

  protected readonly layouts: readonly LayoutOption[] = [
    { value: 'bento', icon: 'layout-grid', label: 'Bento' },
    { value: 'classic', icon: 'rows', label: 'Classique' },
  ];

  protected close(): void {
    this.settings.closePanel();
  }
}
