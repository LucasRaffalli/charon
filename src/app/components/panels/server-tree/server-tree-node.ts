import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { Icon } from '@app/components/icon/icon';
import { TreeNode } from '@app/interfaces';
import { SettingsService } from '@app/services/settings.service';
import { SftpService } from '@app/services/sftp.service';
import { SftpTreeService } from '@app/services/sftp-tree.service';

/** Un nœud de l'arborescence serveur, rendu récursivement. */
@Component({
  selector: 'app-server-tree-node',
  imports: [Icon, ServerTreeNode],
  templateUrl: './server-tree-node.html',
  styleUrl: './server-tree-node.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerTreeNode {
  readonly node = input.required<TreeNode>();
  readonly depth = input(0);

  protected readonly tree = inject(SftpTreeService);
  protected readonly sftp = inject(SftpService);
  private readonly settings = inject(SettingsService);

  protected visibleChildren(): TreeNode[] {
    const children = this.node().children ?? [];
    return this.settings.showHidden()
      ? children
      : children.filter((child) => !child.name.startsWith('.'));
  }

  /** Ouvre ce dossier dans la vue principale (l'arbre suivra via le service). */
  protected open(): void {
    void this.sftp.listDir(this.node().path);
  }
}
