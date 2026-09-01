import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { Transfer, VerifyState } from '@app/interfaces';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { Session, SessionRegistry } from '@app/services/connection/session-registry';
import { TabBarService } from '@app/services/workspace/tab-bar.service';
import { injectT } from '@app/lang/i18n.service';

/** Une ligne du panneau : le transfert, et la session qui le porte. */
interface TransferRow {
  transfer: Transfer;
  session: Session;
}

/**
 * L'onglet Transferts : TOUTES les sessions de la fenêtre, agrégées (jalon 4
 * de la flotte v2). Dix transferts répartis sur trois onglets se surveillent
 * d'un seul endroit ; la vignette dit à quelle session appartient chaque
 * ligne dès qu'il y en a plus d'une.
 */
@Component({
  selector: 'app-transfer-panel',
  imports: [Icon, FileSizePipe],
  templateUrl: './transfer-panel.html',
  styleUrl: './transfer-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransferPanel {
  protected readonly t = injectT();
  private readonly sessionRegistry = inject(SessionRegistry);
  private readonly tabBar = inject(TabBarService);

  protected readonly rows = computed<TransferRow[]>(() =>
    this.sessionRegistry
      .sessions()
      .flatMap((session) =>
        session.transfers.transfers().map((transfer) => ({ transfer, session })),
      ),
  );

  /** La vignette de session n'apparaît qu'à deux sessions : seule, elle radote. */
  protected readonly multiSession = computed(() => this.sessionRegistry.sessions().length > 1);

  protected readonly activeTotal = computed(() =>
    this.sessionRegistry
      .sessions()
      .reduce((count, session) => count + session.transfers.activeCount(), 0),
  );

  protected sessionTitle(session: Session): string {
    return this.tabBar.displayTitleOf(session);
  }

  protected sessionToneBg(session: Session): string {
    return `var(--session-${this.sessionRegistry.toneOf(session)})`;
  }

  protected clearFinished(): void {
    for (const session of this.sessionRegistry.sessions()) {
      session.transfers.clearFinished();
    }
  }

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

  protected percent(transfer: Transfer): number {
    if (transfer.status === 'done') {
      return 100;
    }
    if (transfer.total === 0) {
      return 0;
    }
    return Math.min(100, Math.round((transfer.transferred / transfer.total) * 100));
  }

  protected statusLabel(row: TransferRow): string {
    switch (row.transfer.status) {
      case 'done':
        return 'Terminé';
      case 'error':
        return 'Échec';
      case 'cancelled':
        return 'Annulé';
      case 'interrupted':
        return row.session.transfers.canResume(row.transfer)
          ? 'Interrompu'
          : 'Interrompu : reconnecte-toi';
      default:
        return '';
    }
  }
}
