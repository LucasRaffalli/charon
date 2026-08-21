import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { ActivityLog } from '@app/components/activity-log/activity-log';
import { Icon } from '@app/components/icon/icon';
import { TabItem, Tabs } from '@app/components/tabs/tabs';
import { TerminalPane } from '@app/components/terminal-pane/terminal-pane';
import { TransferPanel } from '@app/components/transfer-panel/transfer-panel';
import { SettingsService } from '@app/services/settings.service';
import { TransfersService } from '@app/services/transfers.service';

/**
 * Panneau inférieur multi-features, sous les deux colonnes de l'explorateur.
 * Onglets : Transferts, Journal, Terminal (SFTP). Les contenus restent
 * montés au changement d'onglet (masqués) : la session du terminal survit.
 * État (déplié + onglet actif) persisté dans les réglages.
 */
@Component({
  selector: 'app-bottom-panel',
  imports: [ActivityLog, Icon, Tabs, TerminalPane, TransferPanel],
  templateUrl: './bottom-panel.html',
  styleUrl: './bottom-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BottomPanel {
  protected readonly settings = inject(SettingsService);
  private readonly transfers = inject(TransfersService);

  protected readonly tabs = computed<TabItem[]>(() => {
    const active = this.transfers.activeCount();
    return [
      {
        id: 'transfers',
        label: active > 0 ? `Transferts · ${active}` : 'Transferts',
        icon: 'arrow-down-up',
      },
      { id: 'journal', label: 'Journal', icon: 'info' },
      { id: 'terminal', label: 'Terminal', icon: 'terminal' },
    ];
  });

  protected readonly activeTab = computed(() => this.settings.bottomPanelTab());

  /** Le terminal ne démarre qu'à la première activation de son onglet
   *  (verrou alimenté par les réglages : la command palette peut l'ouvrir). */
  protected readonly terminalStarted = signal(false);

  constructor() {
    effect(() => {
      if (this.settings.bottomPanelTab() === 'terminal' && this.settings.bottomPanelOpen()) {
        this.terminalStarted.set(true);
      }
    });
  }

  protected selectTab(id: string): void {
    // Sélectionner un onglet déplie le panneau s'il était replié
    // (l'effect du constructeur arme le terminal si besoin).
    this.settings.update({ bottomPanelTab: id, bottomPanelOpen: true });
  }

  protected toggle(): void {
    this.settings.update({ bottomPanelOpen: !this.settings.bottomPanelOpen() });
  }
}
