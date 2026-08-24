import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { ActivityLog } from '@app/components/panels/activity-log/activity-log';
import { Alert } from '@app/components/ui/alert/alert';
import { Button } from '@app/components/ui/button/button';
import { Dock } from '@app/components/dock/dock';
import { FilePane } from '@app/components/panels/file-pane/file-pane';
import { Icon } from '@app/components/ui/icon/icon';
import { LogPane } from '@app/components/panels/log-pane/log-pane';
import { ModulePanel } from '@app/components/panels/module-panel/module-panel';
import { FileEntry } from '@app/interfaces';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { RemoteEditBar } from '@app/components/overlays/remote-edit-bar/remote-edit-bar';
import { PreviewPanel } from '@app/components/panels/preview-panel/preview-panel';
import { ServerTree } from '@app/components/panels/server-tree/server-tree';
import { TerminalPane } from '@app/components/panels/terminal-pane/terminal-pane';
import { TransferPanel } from '@app/components/panels/transfer-panel/transfer-panel';
import { ContextMenuItem, ContextMenuService } from '@app/services/context-menu.service';
import { DialogService } from '@app/services/dialog.service';
import { DockService, PANEL_META } from '@app/services/dock.service';
import { FileBrowserState } from '@app/services/file-browser-state';
import { lineDiff } from '@app/services/diff';
import { LocalFsService } from '@app/services/local-fs.service';
import { LogTailService } from '@app/services/log-tail.service';
import { OverwriteService } from '@app/services/overwrite.service';
import { PreviewService } from '@app/services/preview.service';
import { RemoteEditService } from '@app/services/remote-edit.service';
import { SettingsService } from '@app/services/settings.service';
import { SftpService } from '@app/services/sftp.service';
import { TransfersService } from '@app/services/transfers.service';
import { UpdaterService } from '@app/services/updater.service';

/** Nom d'entrée valide : pas de séparateur, pas de `.` / `..`. */
const isValidEntryName = (name: string): boolean =>
  !/[/\\]/.test(name) && name !== '.' && name !== '..';

@Component({
  selector: 'app-explorer-page',
  imports: [
    ActivityLog,
    Alert,
    Dock,
    RemoteEditBar,
    PreviewPanel,
    Button,
    FilePane,
    Icon,
    LogPane,
    ModulePanel,
    ServerTree,
    TerminalPane,
    TransferPanel,
    FileSizePipe,
  ],
  templateUrl: './explorer-page.html',
  styleUrl: './explorer-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExplorerPage {
  protected readonly sftp = inject(SftpService);
  protected readonly localFs = inject(LocalFsService);
  protected readonly settings = inject(SettingsService);
  protected readonly contextMenu = inject(ContextMenuService);
  protected readonly transfers = inject(TransfersService);
  private readonly logTail = inject(LogTailService);
  private readonly overwrite = inject(OverwriteService);
  private readonly remoteEdit = inject(RemoteEditService);
  protected readonly preview = inject(PreviewService);
  private readonly dialog = inject(DialogService);
  protected readonly dock = inject(DockService);
  protected readonly updater = inject(UpdaterService);

  /** Taille max lue de chaque côté pour l'aperçu de diff (256 Kio). */
  private static readonly DIFF_MAX_BYTES = 256 * 1024;
  private readonly destroyRef = inject(DestroyRef);

  protected readonly localEntries = computed(() => this.withoutHidden(this.localFs.entries()));
  protected readonly serverEntries = computed(() => this.withoutHidden(this.sftp.entries()));

  /** Un glisser-déposer de fichiers survole le container serveur. */
  protected readonly dropActive = signal(false);

  /** Le container serveur : seule zone de dépôt valide. */
  private readonly serverZone = viewChild.required<ElementRef<HTMLElement>>('serverZone');

  /** Le terminal ne démarre qu'à la première activation de son panneau. */
  protected readonly terminalReady = signal(false);

  /** Libellés/icônes des panneaux (réouverture depuis la barre de statut). */
  protected readonly panelMeta = PANEL_META;

  constructor() {
    void this.localFs.init();
    this.listenDragDrop();

    effect(() => {
      if (
        this.dock.activePanels().has('terminal') &&
        this.sftp.connected() &&
        this.sftp.protocol() === 'sftp'
      ) {
        this.terminalReady.set(true);
      }
    });
  }

  /**
   * Upload par glisser-déposer : seul le container serveur accepte le dépôt,
   * vers le dossier serveur courant. Les events Tauri sont au niveau fenêtre,
   * on teste donc la position du curseur contre le rect du container.
   */
  private listenDragDrop(): void {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          this.dropActive.set(this.isOverServerZone(event.payload.position));
        } else if (event.payload.type === 'leave') {
          this.dropActive.set(false);
        } else {
          this.dropActive.set(false);
          if (this.isOverServerZone(event.payload.position)) {
            void this.uploadDropped(event.payload.paths);
          }
        }
      })
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));
  }

  /** La position (pixels physiques) est-elle au-dessus du container serveur ? */
  private isOverServerZone(position: { x: number; y: number }): boolean {
    const rect = this.serverZone().nativeElement.getBoundingClientRect();
    const x = position.x / window.devicePixelRatio;
    const y = position.y / window.devicePixelRatio;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private async uploadDropped(paths: string[]): Promise<void> {
    if (!this.sftp.connected() || paths.length === 0) {
      return;
    }
    if (this.sftp.protection() === 'readonly') {
      this.sftp.reportError('Serveur en lecture seule : dépôt refusé.');
      return;
    }
    // Séquentiel : un seul dialogue « écraser ? » à la fois.
    let anyDone = false;
    for (const path of paths) {
      const name = path.split('/').pop() ?? path;
      if (await this.uploadWithGuard(path, this.sftp.pathTo(name), name)) {
        anyDone = true;
      }
    }
    if (anyDone) {
      await this.sftp.refresh();
    }
  }

  /**
   * Upload avec garde d'écrasement : si la cible existe déjà (SFTP), propose
   * un aperçu de diff et alerte si la version serveur est plus récente
   * (détection de conflit). Renvoie true si le transfert a abouti.
   */
  private async uploadWithGuard(
    localPath: string,
    remotePath: string,
    name: string,
  ): Promise<boolean> {
    if (this.sftp.protocol() === 'sftp' && this.sftp.protection() !== 'readonly') {
      const remote = await this.sftp.stat(remotePath);
      if (remote?.exists && !remote.isDir) {
        const local = (await this.localFs.stat(localPath)) ?? {
          exists: true,
          isDir: false,
          size: 0,
          mtime: 0,
        };
        const remoteNewer =
          remote.mtime > 0 && local.mtime > 0 && remote.mtime > local.mtime;
        const decision = await this.overwrite.request({
          name,
          remoteNewer,
          local,
          remote,
          loadDiff: async () => {
            const [remoteText, localText] = await Promise.all([
              this.sftp.readText(remotePath, ExplorerPage.DIFF_MAX_BYTES),
              this.localFs.readText(localPath, ExplorerPage.DIFF_MAX_BYTES),
            ]);
            if (remoteText === undefined || localText === undefined) {
              return null;
            }
            if (remoteText.includes('\u0000') || localText.includes('\u0000')) {
              return null; // binaire
            }
            return lineDiff(remoteText, localText);
          },
        });
        if (decision !== 'overwrite') {
          return false;
        }
      }
    }
    return this.transfers.upload(localPath, remotePath, name);
  }

  protected open(entry: FileEntry): void {
    if (entry.isDir) {
      void this.sftp.openDir(entry.name);
    } else {
      // Rouvre le panneau Aperçu s'il était fermé (ou le focalise).
      this.dock.openPanel('preview');
      void this.preview.openFile(this.sftp.pathTo(entry.name), entry.name);
    }
  }

  protected openLocalDir(entry: FileEntry): void {
    void this.localFs.openDir(entry.name);
  }

  protected openServerDir(entry: FileEntry): void {
    void this.sftp.openDir(entry.name);
  }

  /** Envoie un fichier local vers le dossier serveur courant. */
  protected async upload(entry: FileEntry): Promise<void> {
    const done = await this.uploadWithGuard(
      this.localFs.pathTo(entry.name),
      this.sftp.pathTo(entry.name),
      entry.name,
    );
    if (done) {
      await this.sftp.refresh();
    }
  }

  /** Télécharge un fichier du serveur vers le dossier local courant. */
  protected async download(entry: FileEntry): Promise<void> {
    const done = await this.transfers.download(
      this.sftp.pathTo(entry.name),
      this.localFs.pathTo(entry.name),
      entry.name,
    );
    if (done) {
      await this.localFs.refresh();
    }
  }

  // --- Menus contextuels ---

  protected openServerEntryMenu(event: MouseEvent, entry: FileEntry): void {
    const first: ContextMenuItem = entry.isDir
      ? { label: 'Ouvrir', icon: 'folder', action: () => void this.sftp.openDir(entry.name) }
      : { label: 'Télécharger', icon: 'download', action: () => void this.download(entry) };
    const items: ContextMenuItem[] = [first];
    if (!entry.isDir && this.sftp.protocol() === 'sftp') {
      items.push({
        label: 'Aperçu',
        icon: 'file',
        action: () => {
          this.dock.openPanel('preview');
          void this.preview.openFile(this.sftp.pathTo(entry.name), entry.name);
        },
      });
      if (this.sftp.protection() !== 'readonly') {
        items.push({
          label: 'Éditer (éditeur système)',
          icon: 'edit',
          action: () => void this.remoteEdit.start(this.sftp.pathTo(entry.name), entry.name),
        });
      }
      items.push({
        label: 'Suivre en direct',
        icon: 'logs',
        action: () => void this.followLog(entry),
      });
    }
    items.push(
      { divider: true, label: '' },
      {
        label: 'Copier le nom',
        icon: 'copy',
        action: () => this.copyPath(entry.name),
      },
      {
        label: 'Copier le chemin',
        icon: 'copy',
        action: () => this.copyPath(this.sftp.pathTo(entry.name)),
      },
    );
    const writes = this.entryActions(this.sftp, entry);
    this.contextMenu.open(
      event,
      writes.length ? [...items, { divider: true, label: '' }, ...writes] : items,
    );
  }

  /** Ouvre le suivi de log dans le panneau Logs (rouvert au besoin). */
  private async followLog(entry: FileEntry): Promise<void> {
    this.dock.openPanel('logs');
    await this.logTail.open(this.sftp.pathTo(entry.name));
  }

  /** Copie un chemin dans le presse-papier. */
  private copyPath(path: string): void {
    void navigator.clipboard.writeText(path).catch(() => undefined);
  }

  protected openServerAreaMenu(event: MouseEvent): void {
    this.contextMenu.open(event, [
      ...this.areaActions(this.sftp, 'sur le serveur'),
      { divider: true, label: '' },
      {
        label: 'Copier le chemin courant',
        icon: 'copy',
        action: () => this.copyPath(this.sftp.currentPath()),
      },
    ]);
  }

  protected openLocalEntryMenu(event: MouseEvent, entry: FileEntry): void {
    const first: ContextMenuItem = entry.isDir
      ? { label: 'Ouvrir', icon: 'folder', action: () => void this.localFs.openDir(entry.name) }
      : { label: 'Envoyer vers le serveur', icon: 'upload', action: () => void this.upload(entry) };
    const copy: ContextMenuItem[] = [
      { divider: true, label: '' },
      { label: 'Copier le nom', icon: 'copy', action: () => this.copyPath(entry.name) },
      {
        label: 'Copier le chemin',
        icon: 'copy',
        action: () => this.copyPath(this.localFs.pathTo(entry.name)),
      },
    ];
    const writes = this.entryActions(this.localFs, entry);
    this.contextMenu.open(event, [
      first,
      ...copy,
      ...(writes.length ? [{ divider: true, label: '' } as ContextMenuItem, ...writes] : []),
    ]);
  }

  protected openLocalAreaMenu(event: MouseEvent): void {
    this.contextMenu.open(event, this.areaActions(this.localFs, 'local'));
  }

  private entryActions(browser: FileBrowserState, entry: FileEntry): ContextMenuItem[] {
    // Lecture seule : aucune action d'écriture côté serveur.
    if (browser === this.sftp && this.sftp.protection() === 'readonly') {
      return [];
    }
    return [
      { label: 'Renommer…', icon: 'pencil', action: () => void this.renameEntry(browser, entry) },
      {
        label: 'Supprimer',
        icon: 'trash',
        danger: true,
        action: () => void this.deleteEntry(browser, entry),
      },
    ];
  }

  /** `where` = « sur le serveur » / « local » (suffixe des titres de dialogue). */
  private areaActions(browser: FileBrowserState, where: string): ContextMenuItem[] {
    const refresh: ContextMenuItem = {
      label: 'Actualiser',
      icon: 'refresh',
      action: () => void browser.refresh(),
    };
    if (browser === this.sftp && this.sftp.protection() === 'readonly') {
      return [refresh];
    }
    return [
      {
        label: 'Nouveau dossier…',
        icon: 'folder-plus',
        action: () => void this.createDirIn(browser, `Nouveau dossier ${where}`),
      },
      {
        label: 'Nouveau fichier…',
        icon: 'file',
        action: () => void this.createFileIn(browser, `Nouveau fichier ${where}`),
      },
      refresh,
    ];
  }

  private async renameEntry(browser: FileBrowserState, entry: FileEntry): Promise<void> {
    const name = (
      await this.dialog.prompt({
        title: `Renommer « ${entry.name} »`,
        value: entry.name,
        confirmLabel: 'Renommer',
      })
    )?.trim();
    if (name && name !== entry.name && isValidEntryName(name)) {
      await browser.rename(entry, name);
    }
  }

  private async deleteEntry(browser: FileBrowserState, entry: FileEntry): Promise<void> {
    // Serveur protégé « confirmation » : toute suppression exige de
    // retaper le NOM D'HÔTE (façon GitHub), fichier comme dossier.
    if (browser === this.sftp && this.sftp.protection() === 'confirm') {
      const host = this.sftp.host();
      const typed = await this.dialog.prompt({
        title: `Serveur protégé : supprimer « ${entry.name} » ?`,
        message:
          (entry.isDir
            ? 'Le dossier et tout son contenu seront supprimés définitivement. '
            : 'Cette action est définitive. ') + `Tape « ${host} » pour confirmer.`,
        placeholder: host,
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (typed?.trim() === host) {
        await browser.remove(entry);
      }
      return;
    }

    if (!entry.isDir) {
      const confirmed = await this.dialog.confirm({
        title: `Supprimer « ${entry.name} » ?`,
        message: 'Cette action est définitive.',
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (confirmed) {
        await browser.remove(entry);
      }
      return;
    }

    // Suppression récursive : confirmation renforcée, taper le nom du dossier.
    const typed = await this.dialog.prompt({
      title: `Supprimer « ${entry.name} » et tout son contenu ?`,
      message:
        `Le dossier et tout ce qu'il contient seront supprimés définitivement. ` +
        `Tape « ${entry.name} » pour confirmer.`,
      placeholder: entry.name,
      confirmLabel: 'Tout supprimer',
      danger: true,
    });
    if (typed?.trim() === entry.name) {
      await browser.remove(entry);
    }
  }

  private async createDirIn(browser: FileBrowserState, title: string): Promise<void> {
    const name = (
      await this.dialog.prompt({ title, placeholder: 'nom-du-dossier', confirmLabel: 'Créer' })
    )?.trim();
    if (name && isValidEntryName(name)) {
      await browser.mkdir(name);
    }
  }

  private async createFileIn(browser: FileBrowserState, title: string): Promise<void> {
    const name = (
      await this.dialog.prompt({ title, placeholder: 'nom-du-fichier.txt', confirmLabel: 'Créer' })
    )?.trim();
    if (name && isValidEntryName(name)) {
      await browser.mkfile(name);
    }
  }

  private withoutHidden(entries: FileEntry[]): FileEntry[] {
    return this.settings.showHidden()
      ? entries
      : entries.filter((entry) => !entry.name.startsWith('.'));
  }

  /** Ferme la connexion ; demande confirmation si des transferts sont actifs. */
  protected async disconnect(): Promise<void> {
    const active = this.transfers.activeCount();
    if (active > 0) {
      const confirmed = await this.dialog.confirm({
        title: 'Débarquer ?',
        message:
          active === 1
            ? 'Un transfert est en cours : il sera interrompu (reprise possible après reconnexion).'
            : `${active} transferts sont en cours : ils seront interrompus (reprise possible après reconnexion).`,
        confirmLabel: 'Débarquer',
        danger: true,
      });
      if (!confirmed) {
        return;
      }
    }
    await this.sftp.disconnect();
  }
}
