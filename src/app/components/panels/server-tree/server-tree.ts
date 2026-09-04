import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { ServerTreeNode } from '@app/components/panels/server-tree/server-tree-node';
import { SftpTreeService } from '@app/services/connection/sftp-tree.service';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { injectT } from '@app/lang/i18n.service';

/** Panneau latéral : arborescence des dossiers du serveur depuis la racine. */
@Component({
  selector: 'app-server-tree',
  imports: [Icon, ServerTreeNode],
  templateUrl: './server-tree.html',
  styleUrl: './server-tree.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerTree {
  protected readonly t = injectT();
  private readonly sessionRegistry = inject(SessionRegistry);

  protected get tree(): SftpTreeService {
    return this.sessionRegistry.focused().tree;
  }

  /**
   * La racine de l'arbre, en signal DÉRIVÉ et non en appel de getter dans le
   * template. Le `computed` établit une dépendance stable sur le signal du
   * service de la session focalisée : quand l'arbre est patché (navigation,
   * création, suppression), la vue est notifiée. Une chaîne d'appels
   * `tree.root()` posée directement dans le template laissait l'affichage
   * figé jusqu'au prochain clic.
   */
  protected readonly root = computed(() => this.sessionRegistry.focused().tree.root());
}
