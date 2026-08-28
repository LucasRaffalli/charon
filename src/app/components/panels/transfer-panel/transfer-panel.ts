import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { Transfer, VerifyState } from '@app/interfaces';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { TransfersService } from '@app/services/files/transfers.service';

/** Contenu de l'onglet Transferts du panneau inférieur. */
@Component({
  selector: 'app-transfer-panel',
  imports: [Icon, FileSizePipe],
  templateUrl: './transfer-panel.html',
  styleUrl: './transfer-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransferPanel {
  /** L'état de la vérification d'intégrité, en un mot. */
  protected verifyLabel(state: VerifyState): string {
    switch (state) {
      case 'checking':
        return 'sha256…';
      case 'ok':
        return 'intègre';
      case 'mismatch':
        return 'empreintes différentes';
      case 'skipped':
        return 'non vérifié';
      default:
        return 'vérification impossible';
    }
  }

  /** Le détail, en infobulle : pourquoi ça n'a pas pu être vérifié. */
  protected verifyTitle(transfer: Transfer): string {
    if (transfer.verify === 'ok') {
      return 'Les empreintes sha256 locale et distante concordent.';
    }
    if (transfer.verify === 'mismatch') {
      return 'Le fichier transféré diffère de la source.';
    }
    return transfer.verifyDetail ?? '';
  }

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
        return this.transfers.canResume(transfer) ? 'Interrompu' : 'Interrompu : reconnecte-toi';
      default:
        return '';
    }
  }
}
