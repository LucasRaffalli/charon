import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { revealItemInDir } from '@tauri-apps/plugin-opener';

import { Icon } from '@app/components/ui/icon/icon';
import { injectT } from '@app/lang/i18n.service';
import { TreeNode } from '@app/interfaces';
import { DockService } from '@app/services/workspace/dock.service';
import { PreviewService } from '@app/services/files/preview.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { FileTree } from '@app/services/connection/sftp-tree.service';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { LocalTreeService } from '@app/services/connection/local-tree.service';
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
  /** Arbre LOCAL (issue #9) : même moteur, même rendu, autre disque. */
  readonly local = input(false);

  private readonly sessionRegistry = inject(SessionRegistry);
  private readonly localTree = inject(LocalTreeService);
  private readonly localFs = inject(LocalFsService);

  protected get tree(): FileTree {
    return this.local() ? this.localTree : this.sessionRegistry.focused().tree;
  }
  protected get sftp(): SftpService {
    return this.sessionRegistry.focused().sftp;
  }

  /** Le dossier affiché par le panneau que CET arbre gouverne : le local
   *  quand il est local, le serveur sinon. Le surlignage suivait le serveur
   *  dans les deux cas. */
  protected readonly currentPath = computed(() =>
    this.local() ? this.localFs.currentPath() : this.sessionRegistry.focused().sftp.currentPath(),
  );

  protected readonly t = injectT();
  private readonly settings = inject(SettingsService);
  private get preview(): PreviewService {
    return this.sessionRegistry.focused().preview;
  }
  private readonly dock = inject(DockService);

  /** En `computed` : une méthode de template n'est rappelée que si la vue est
   *  déjà en train d'être redessinée, et elle réallouait un tableau filtré à
   *  chaque cycle, pour chaque nœud déplié. */
  protected readonly visibleChildren = computed<TreeNode[]>(() => {
    const children = this.node().children ?? [];
    return this.settings.showHidden()
      ? children
      : children.filter((child) => !child.name.startsWith('.'));
  });

  /**
   * Dossier : ouvre dans la vue principale (le panneau du même disque) ;
   * fichier : l'aperçu côté serveur, le Finder côté local — l'aperçu ne lit
   * que le distant, et « montrer le fichier » est le geste local naturel.
   */
  protected open(): void {
    const node = this.node();
    if (this.local()) {
      if (node.isDir) {
        void this.localFs.listDir(node.path);
      } else {
        void revealItemInDir(node.path).catch(() => undefined);
      }
      return;
    }
    if (node.isDir) {
      void this.sftp.listDir(node.path);
    } else {
      this.dock.focusPanel('preview');
      void this.preview.openFile(node.path, node.name);
    }
  }
}
