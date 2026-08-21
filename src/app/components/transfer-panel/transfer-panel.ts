import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Icon } from '@app/components/icon/icon';
import { Transfer } from '@app/interfaces';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { TransfersService } from '@app/services/transfers.service';

/** Contenu de l'onglet Transferts du panneau inférieur. */
@Component({
  selector: 'app-transfer-panel',
  imports: [Icon, FileSizePipe],
  templateUrl: './transfer-panel.html',
  styleUrl: './transfer-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransferPanel {
  protected readonly transfers = inject(TransfersService);

  protected percent(transfer: Transfer): number {
    if (transfer.status === 'done') {
      return 100;
    }
    if (transfer.total === 0) {
      return 0;
    }
    return Math.min(100, Math.round((transfer.transferred / transfer.total) * 100));
  }

  protected statusLabel(transfer: Transfer): string {
    switch (transfer.status) {
      case 'done':
        return 'Terminé';
      case 'error':
        return 'Échec';
      case 'cancelled':
        return 'Annulé';
      case 'interrupted':
        return this.transfers.canResume(transfer) ? 'Interrompu' : 'Interrompu — reconnecte-toi';
      default:
        return '';
    }
  }
}
