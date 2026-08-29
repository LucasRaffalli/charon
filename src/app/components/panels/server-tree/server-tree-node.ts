import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { TreeNode } from '@app/interfaces';
import { DockService } from '@app/services/workspace/dock.service';
import { PreviewService } from '@app/services/files/preview.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { SftpTreeService } from '@app/services/connection/sftp-tree.service';
import { SessionRegistry } from '@app/services/connection/session-registry';

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

  private readonly sessionRegistry = inject(SessionRegistry);

  protected get tree(): SftpTreeService {
    return this.sessionRegistry.focused().tree;
  }
  protected get sftp(): SftpService {
    return this.sessionRegistry.focused().sftp;
  }
  private readonly settings = inject(SettingsService);
  private get preview(): PreviewService {
    return this.sessionRegistry.focused().preview;
  }
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
