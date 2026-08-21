import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ActivityLog } from '@app/components/activity-log/activity-log';
import { Icon } from '@app/components/icon/icon';
import { TabItem, Tabs } from '@app/components/tabs/tabs';
import { TransferPanel } from '@app/components/transfer-panel/transfer-panel';
import { SettingsService } from '@app/services/settings.service';
import { TransfersService } from '@app/services/transfers.service';

/**
 * Panneau inférieur multi-features, sous les deux colonnes de l'explorateur.
 * Onglets actuels : Transferts, Journal. À venir : Terminal.
 * État (déplié + onglet actif) persisté dans les réglages.
 */
@Component({
  selector: 'app-bottom-panel',
  imports: [ActivityLog, Icon, Tabs, TransferPanel],
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
    ];
  });

  protected readonly activeTab = computed(() => this.settings.bottomPanelTab());

  protected selectTab(id: string): void {
    // Sélectionner un onglet déplie le panneau s'il était replié.
    this.settings.update({ bottomPanelTab: id, bottomPanelOpen: true });
  }

  protected toggle(): void {
    this.settings.update({ bottomPanelOpen: !this.settings.bottomPanelOpen() });
  }
}
