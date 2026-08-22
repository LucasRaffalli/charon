import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { ServerTreeNode } from '@app/components/panels/server-tree/server-tree-node';
import { SftpTreeService } from '@app/services/sftp-tree.service';

/** Panneau latéral : arborescence des dossiers du serveur depuis la racine. */
@Component({
  selector: 'app-server-tree',
  imports: [Icon, ServerTreeNode],
  templateUrl: './server-tree.html',
  styleUrl: './server-tree.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerTree {
  protected readonly tree = inject(SftpTreeService);
}
