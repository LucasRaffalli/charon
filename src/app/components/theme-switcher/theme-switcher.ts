import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Icon, IconName } from '@app/components/icon/icon';
import { Theme } from '@app/interfaces';
import { ThemeService } from '@app/services/theme.service';

export interface ThemeOption {
  value: Theme;
  icon: IconName;
  label: string;
}

/** Liste unique des thèmes proposés, partagée avec le panneau de réglages. */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'light', icon: 'sun', label: 'Clair' },
  { value: 'dark', icon: 'moon', label: 'Sombre' },
  { value: 'contrast', icon: 'contrast', label: 'Contraste' },
  { value: 'unicorn', icon: 'sparkles', label: 'Unicorn' },
];

@Component({
  selector: 'app-theme-switcher',
  imports: [Icon],
  templateUrl: './theme-switcher.html',
  styleUrl: './theme-switcher.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ThemeSwitcher {
  protected readonly themeService = inject(ThemeService);

  protected readonly options = THEME_OPTIONS;
}
