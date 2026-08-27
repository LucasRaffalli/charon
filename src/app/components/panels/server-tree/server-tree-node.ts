import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { TreeNode } from '@app/interfaces';
import { DockService } from '@app/services/workspace/dock.service';
import { PreviewService } from '@app/services/files/preview.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { SftpTreeService } from '@app/services/connection/sftp-tree.service';

/** Un nœud de l'arborescence serveur (dossier ou fichier), rendu récursivement. */
@Component({
  selector: 'app-server-tree-node',
  imports: [Icon, ServerTreeNode],
  templateUrl: './server-tree-node.html',
  styleUrl: './server-tree-node.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerTreeNode {
  readonly node = input.required<TreeNode>();

  protected readonly tree = inject(SftpTreeService);
  protected readonly sftp = inject(SftpService);
  private readonly settings = inject(SettingsService);
  private readonly preview = inject(PreviewService);
  private readonly dock = inject(DockService);

  protected visibleChildren(): TreeNode[] {
    const children = this.node().children ?? [];
    return this.settings.showHidden()
      ? children
      : children.filter((child) => !child.name.startsWith('.'));
  }

  /** Dossier : ouvre dans la vue principale ; fichier : ouvre l'aperçu. */
  protected open(): void {
    const node = this.node();
    if (node.isDir) {
      void this.sftp.listDir(node.path);
    } else {
      this.dock.focusPanel('preview');
      void this.preview.openFile(node.path, node.name);
    }
  }
}
