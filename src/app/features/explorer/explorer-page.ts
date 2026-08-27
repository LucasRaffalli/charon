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
import { SearchPane } from '@app/components/panels/search-pane/search-pane';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { ModulePanel } from '@app/components/panels/module-panel/module-panel';
import { FileEntry } from '@app/interfaces';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { RemoteEditBar } from '@app/components/overlays/remote-edit-bar/remote-edit-bar';
import { PreviewPanel } from '@app/components/panels/preview-panel/preview-panel';
import { ServerTree } from '@app/components/panels/server-tree/server-tree';
import { TerminalPane } from '@app/components/panels/terminal-pane/terminal-pane';
import { TransferPanel } from '@app/components/panels/transfer-panel/transfer-panel';
import { ContextMenuItem, ContextMenuService } from '@app/services/workspace/context-menu.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { DockService, PANEL_META } from '@app/services/workspace/dock.service';
import { FileBrowserState } from '@app/services/connection/file-browser-state';
import { lineDiff } from '@app/services/files/diff';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { LogTailService } from '@app/services/files/log-tail.service';
import { OverwriteService } from '@app/services/files/overwrite.service';
import { PreviewService } from '@app/services/files/preview.service';
import { RemoteEditService } from '@app/services/files/remote-edit.service';
import { AppearanceService } from '@app/services/appearance/appearance.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { CommandPaletteService } from '@app/services/workspace/command-palette.service';
import { ProfilesService } from '@app/services/connection/profiles.service';
import { SearchService } from '@app/services/connection/search.service';
import { TerminalService } from '@app/services/workspace/terminal.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { TransfersService } from '@app/services/files/transfers.service';
import { UpdaterService } from '@app/services/system/updater.service';

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
    SearchPane,
    SegmentedControl,
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
  protected readonly appearance = inject(AppearanceService);
  protected readonly contextMenu = inject(ContextMenuService);
  protected readonly transfers = inject(TransfersService);
  private readonly logTail = inject(LogTailService);
  private readonly overwrite = inject(OverwriteService);
  private readonly remoteEdit = inject(RemoteEditService);
  protected readonly preview = inject(PreviewService);
  private readonly dialog = inject(DialogService);
  protected readonly dock = inject(DockService);
  private readonly toasts = inject(ToastService);
  private readonly terminals = inject(TerminalService);
  private readonly searchService = inject(SearchService);
  private readonly palette = inject(CommandPaletteService);
  private readonly profiles = inject(ProfilesService);
  protected readonly updater = inject(UpdaterService);

  /** Taille max lue de chaque côté pour l'aperçu de diff (256 Kio). */
  private static readonly DIFF_MAX_BYTES = 256 * 1024;
  private readonly destroyRef = inject(DestroyRef);

  protected readonly localEntries = computed(() => this.withoutHidden(this.localFs.filteredEntries()));
  protected readonly serverEntries = computed(() => this.withoutHidden(this.sftp.filteredEntries()));

  /** Le filtre du listing serveur retire des lignes : dit combien, et lesquelles reviennent. */
  protected readonly serverFilterActive = computed(
    () => this.sftp.filter().trim() !== '' || this.sftp.kindFilter() !== 'all',
  );

  protected readonly kindOptions: readonly SegmentedOption[] = [
    { value: 'all', label: 'Tout' },
    { value: 'dirs', label: 'Dossiers' },
    { value: 'files', label: 'Fichiers' },
  ];

  protected onKindFilter(value: string): void {
    this.sftp.kindFilter.set(value as 'all' | 'dirs' | 'files');
  }

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
    if (entry.isDir) {
      items.push(...this.folderActions(this.sftp.pathTo(entry.name)));
    }
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

  /**
   * Copie un chemin dans le presse-papier.
   *
   * Le geste ne laisse aucune trace à l'écran, et le presse-papier ne se
   * regarde pas : sans un mot, rien ne distingue une copie réussie d'un clic
   * qui a raté sa cible.
   */
  private copyPath(path: string): void {
    void navigator.clipboard.writeText(path).then(
      () => this.toasts.success('Chemin copié', path),
      () => this.toasts.error("Le presse-papier n'est pas accessible"),
    );
  }

  protected openServerAreaMenu(event: MouseEvent): void {
    this.contextMenu.open(event, [
      ...this.areaActions(this.sftp, 'sur le serveur'),
      { divider: true, label: '' },
      ...this.folderActions(this.sftp.currentPath()),
      { divider: true, label: '' },
      {
        label: 'Copier le chemin courant',
        icon: 'copy',
        action: () => this.copyPath(this.sftp.currentPath()),
      },
    ]);
  }

  /**
   * Ce qu'on peut faire d'un dossier serveur sans y entrer : y ouvrir un
   * terminal, y chercher, en faire le point d'arrivée du profil.
   *
   * Les trois valent pour le dossier affiché comme pour un sous-dossier
   * désigné à la souris, d'où la mise en commun : un menu qui propose
   * l'ancrage sur le fond mais pas sur une ligne serait arbitraire.
   */
  private folderActions(path: string): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    // Le terminal n'existe qu'en SFTP (il vit sur la session SSH).
    if (this.sftp.protocol() === 'sftp') {
      items.push({
        label: 'Ouvrir le terminal ici',
        icon: 'terminal',
        action: () => {
          this.dock.openPanel('terminal');
          this.terminals.goTo(path);
        },
      });
    }

    items.push({
      label: 'Chercher dans ce dossier',
      icon: 'search',
      action: () => void this.palette.searchIn(path),
    });

    items.push({
      label: 'Rechercher en profondeur…',
      icon: 'search',
      action: () => {
        this.searchService.seed('', path);
        this.dock.openPanel('search');
      },
    });

    // L'ancre n'a de sens qu'attachée à un profil : une connexion de passage
    // n'a rien où l'écrire.
    const profileId = this.sftp.profileId();
    if (profileId) {
      const anchor = this.profiles.anchorOf(profileId);
      if (anchor !== path) {
        items.push({
          label: 'Ancrer pour la connexion',
          icon: 'anchor',
          action: () => void this.profiles.setAnchor(profileId, path),
        });
      } else {
        items.push({
          label: "Retirer l'ancre de connexion",
          icon: 'anchor',
          action: () => void this.profiles.setAnchor(profileId, null),
        });
      }
    }

    return items;
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
