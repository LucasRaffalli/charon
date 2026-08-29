import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';

import { ActivityLog } from '@app/components/panels/activity-log/activity-log';
import { Dock } from '@app/components/dock/dock';
import { FilePane } from '@app/components/panels/file-pane/file-pane';
import { Icon } from '@app/components/ui/icon/icon';
import { LogPane } from '@app/components/panels/log-pane/log-pane';
import { ModulePanel } from '@app/components/panels/module-panel/module-panel';
import { PreviewPanel } from '@app/components/panels/preview-panel/preview-panel';
import { RemoteEditBar } from '@app/components/overlays/remote-edit-bar/remote-edit-bar';
import { SearchPane } from '@app/components/panels/search-pane/search-pane';
import { ServerPane } from '@app/components/panels/server-pane/server-pane';
import { SessionTag } from '@app/components/chrome/session-tag/session-tag';
import { ServerTree } from '@app/components/panels/server-tree/server-tree';
import { TerminalPane } from '@app/components/panels/terminal-pane/terminal-pane';
import { TransferPanel } from '@app/components/panels/transfer-panel/transfer-panel';
import { TrashPane } from '@app/components/panels/trash-pane/trash-pane';
import { DockPanelId, FileEntry } from '@app/interfaces';
import { ForeignDrop } from '@app/services/connection/file-clipboard.service';
import { FileClipboardService } from '@app/services/connection/file-clipboard.service';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { SearchService } from '@app/services/connection/search.service';
import { Session, SessionRegistry } from '@app/services/connection/session-registry';
import { SftpService } from '@app/services/connection/sftp.service';
import { FileActionsService } from '@app/services/files/file-actions.service';
import { PreviewService } from '@app/services/files/preview.service';
import { TransfersService } from '@app/services/files/transfers.service';
import { TrashService } from '@app/services/files/trash.service';
import { AppearanceService } from '@app/services/appearance/appearance.service';
import { SettingsService } from '@app/services/system/settings.service';
import { UpdaterService } from '@app/services/system/updater.service';
import { CommandPaletteService } from '@app/services/workspace/command-palette.service';
import { ContextMenuItem, ContextMenuService } from '@app/services/workspace/context-menu.service';
import { DockService, PANEL_META } from '@app/services/workspace/dock.service';
import { SessionRecapService } from '@app/services/workspace/session-recap.service';
import { Shortcut, ShortcutsService } from '@app/services/workspace/shortcuts.service';
import { TabBarService } from '@app/services/workspace/tab-bar.service';
import { ToastService } from '@app/services/workspace/toast.service';

/**
 * L'ordre de ⌘1 à ⌘9. Fixe et non dérivé de la disposition courante : un
 * raccourci dont la cible change quand on réagence le dock ne s'apprend pas.
 */
const PANEL_ORDER: readonly DockPanelId[] = [
  'server',
  'local',
  'tree',
  'preview',
  'transfers',
  'terminal',
  'search',
  'journal',
  'logs',
];

/**
 * L'espace de travail : le dock et ses panneaux, la barre de statut, les
 * raccourcis, et les relais qui ne peuvent être que de niveau fenêtre (dépôt
 * du Finder, glissé venu d'une autre fenêtre).
 *
 * Le listing serveur vit dans `ServerPane`, un composant PAR SESSION : la vue
 * double (flotte v2) en pose deux côte à côte. Les gestes de fichiers vivent
 * dans `FileActionsService`, appelés ici avec la session focalisée et dans
 * chaque panneau avec la sienne.
 */
@Component({
  selector: 'app-explorer-page',
  imports: [
    ActivityLog,
    Dock,
    RemoteEditBar,
    PreviewPanel,
    FilePane,
    Icon,
    LogPane,
    SearchPane,
    ServerPane,
    SessionTag,
    TrashPane,
    ModulePanel,
    ServerTree,
    TerminalPane,
    TransferPanel,
  ],
  templateUrl: './explorer-page.html',
  styleUrl: './explorer-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExplorerPage {
  protected readonly sessionRegistry = inject(SessionRegistry);
  private readonly tabBar = inject(TabBarService);
  private readonly actions = inject(FileActionsService);

  /** Les services de la session focalisée : accesseurs dynamiques, jamais des
   *  champs : un champ figerait la première session pour toujours. */
  protected get sftp(): SftpService {
    return this.sessionRegistry.focused().sftp;
  }
  protected get transfers(): TransfersService {
    return this.sessionRegistry.focused().transfers;
  }
  /** L'aperçu affiché est celui du dernier fichier ouvert, d'où qu'il vienne
   *  (⌘F et ⌘S visent ce que l'utilisateur a sous les yeux). */
  protected get preview(): PreviewService {
    return this.sessionRegistry.previewOwner().preview;
  }
  protected get clipboard(): FileClipboardService {
    return this.sessionRegistry.focused().clipboard;
  }
  private get searchService(): SearchService {
    return this.sessionRegistry.focused().search;
  }
  private get trash(): TrashService {
    return this.sessionRegistry.focused().trash;
  }

  protected readonly localFs = inject(LocalFsService);
  protected readonly settings = inject(SettingsService);
  protected readonly appearance = inject(AppearanceService);
  protected readonly contextMenu = inject(ContextMenuService);
  protected readonly dock = inject(DockService);
  private readonly dialogToasts = inject(ToastService);
  private readonly document = inject(DOCUMENT);
  private readonly shortcuts = inject(ShortcutsService);
  private readonly recap = inject(SessionRecapService);
  private readonly palette = inject(CommandPaletteService);
  protected readonly updater = inject(UpdaterService);
  private readonly destroyRef = inject(DestroyRef);

  /** Le panneau d'aperçu, pour lui router ⌘F quand il est au premier plan. */
  private readonly previewPanel = viewChild(PreviewPanel);

  /** Les panneaux serveur montés (un par session affichée). */
  private readonly serverPanes = viewChildren(ServerPane);

  /** Le corps du dock, pour rejouer l'animation de bascule d'onglet. */
  private readonly stageBody = viewChild<ElementRef<HTMLElement>>('stageBody');

  /** Les fentes des terminaux et leur pouponnière (voir le template). */
  private readonly termNursery = viewChild<ElementRef<HTMLElement>>('termNursery');
  private readonly termSlotA = viewChild<ElementRef<HTMLElement>>('termSlotA');
  private readonly termSlotB = viewChild<ElementRef<HTMLElement>>('termSlotB');

  /** Terminal 2 n'existe que le temps d'une vue double : hors split, son
   *  bouton de réouverture n'a rien à rouvrir. */
  protected readonly visibleClosedPanels = computed(() =>
    this.dock
      .closedPanels()
      .filter(
        (panel) => panel !== 'terminal2' || this.sessionRegistry.displayed().length > 1,
      ),
  );

  protected readonly localEntries = computed(() =>
    this.withoutHidden(this.localFs.filteredEntries()),
  );

  /** Le terminal ne démarre qu'à la première activation de son panneau. */
  protected readonly terminalReady = signal(false);

  /** Libellés/icônes des panneaux (réouverture depuis la barre de statut). */
  protected readonly panelMeta = PANEL_META;

  /** L'étiquette d'un glissé venu d'une AUTRE fenêtre (relais backend). */
  protected readonly foreignLabel = signal<{ text: string; x: number; y: number } | null>(null);

  constructor() {
    void this.localFs.init();
    this.listenDragDrop();
    this.listenForeignDrag();
    this.destroyRef.onDestroy(this.shortcuts.register(this.declareShortcuts()));

    // Le feu rouge suit le même chemin que ⌘W : le bilan de session d'abord,
    // la fenêtre ensuite. destroy() ne repasse pas par onCloseRequested.
    void getCurrentWebviewWindow()
      .onCloseRequested(async (event) => {
        if (!this.sessionRegistry.sessions().some((session) => session.sftp.connected())) {
          return;
        }
        event.preventDefault();
        await this.requestClose();
      })
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));

    // Purge de la corbeille à l'arrivée (idée 02). Le dossier d'atterrissage
    // seulement : la corbeille vit par point de montage, en balayer toute
    // l'arborescence coûterait un parcours complet à chaque connexion.
    effect(() => {
      if (this.sftp.settled()) {
        const dir = this.sftp.currentPath();
        untracked(() => void this.trash.purge(dir));
      }
    });

    effect(() => {
      if (
        this.dock.activePanels().has('terminal') &&
        this.sftp.connected() &&
        this.sftp.protocol() === 'sftp'
      ) {
        this.terminalReady.set(true);
      }
    });

    // Terminal 2 vit avec la vue double : il s'ouvre quand le split se pose
    // (si le terminal principal est ouvert) et se range quand il se défait.
    effect(() => {
      const split = this.sessionRegistry.displayed().length > 1;
      const termOpen = this.dock.activePanels().has('terminal');
      untracked(() => {
        // Garde ESSENTIELLE : openPanel d'un panneau déjà ouvert le focalise,
        // ce qui réécrit l'arbre du dock, ce qui relançait cet effet : boucle
        // infinie, application gelée à la pose du split.
        if (split && termOpen && !this.dock.activePanels().has('terminal2')) {
          this.dock.openBeside('terminal2', 'terminal', 'right');
        } else if (!split && this.dock.activePanels().has('terminal2')) {
          this.dock.closePanel('terminal2');
        }
      });
    });

    // Le déménageur des terminaux : chaque cellule rejoint sa fente : la
    // deuxième session affichée va dans Terminal 2, tout le reste dans le
    // panneau Terminal (masqué si sa session n'est pas affichée). appendChild
    // et non re-création : xterm et son scrollback survivent au voyage.
    afterRenderEffect(() => {
      const displayed = this.sessionRegistry.displayed();
      const nursery = this.termNursery()?.nativeElement;
      const slotA = this.termSlotA()?.nativeElement;
      const slotB = this.termSlotB()?.nativeElement;
      if (!nursery || !slotA) {
        return;
      }
      const roots = [nursery, slotA, ...(slotB ? [slotB] : [])];
      const cells = roots.flatMap((root) =>
        Array.from(root.querySelectorAll<HTMLElement>('[data-term-session]')),
      );
      for (const cell of cells) {
        const id = cell.dataset['termSession'];
        const second = displayed.length > 1 && displayed[1].id === id;
        const target = second && slotB ? slotB : slotA;
        if (cell.parentElement !== target) {
          target.appendChild(cell);
        }
        cell.classList.toggle(
          'pane-off',
          !displayed.some((session) => session.id === id),
        );
      }
    });

    // La vue double a besoin de largeur : l'arborescence se range quand le
    // split se pose, et revient quand il se défait, seulement si c'est nous
    // qui l'avions rangée, un panneau fermé à la main le reste.
    let treeClosedForSplit = false;
    effect(() => {
      const split = this.sessionRegistry.displayed().length > 1;
      untracked(() => {
        if (split && this.dock.activePanels().has('tree')) {
          this.dock.closePanel('tree');
          treeClosedForSplit = true;
        } else if (!split && treeClosedForSplit) {
          treeClosedForSplit = false;
          this.dock.openPanel('tree');
        }
      });
    });

    // L'animation de bascule d'onglet : un fondu court quand LES SESSIONS
    // AFFICHÉES changent, pas quand le focus circule entre deux panneaux de
    // la vue double, ce serait un clignotement permanent.
    let lastDisplayed = '';
    effect(() => {
      const key = this.sessionRegistry
        .displayed()
        .map((session) => session.id)
        .join('|');
      if (lastDisplayed && key !== lastDisplayed) {
        const body = this.stageBody()?.nativeElement;
        if (body) {
          body.classList.remove('explorer__body--switch');
          // Le reflow force le redémarrage de l'animation CSS.
          void body.offsetWidth;
          body.classList.add('explorer__body--switch');
        }
      }
      lastDisplayed = key;
    });
  }

  private focusedSession(): Session {
    return this.sessionRegistry.focused();
  }

  /** Le nom et la couleur d'une session, pour les vignettes des terminaux. */
  protected sessionTitle(session: Session): string {
    return this.tabBar.titleOf(session);
  }

  /** Le voile de coin d'une session, pour la vignette de son terminal. */
  protected sessionWash(session: Session): string {
    const tone = this.sessionRegistry.toneOf(session);
    return `linear-gradient(225deg, color-mix(in srgb, var(--session-${tone}) 40%, transparent), transparent 72%)`;
  }

  /** Le panneau serveur de la session focalisée, s'il est monté. */
  private focusedPane(): ServerPane | undefined {
    return this.serverPanes().find((pane) => pane.session() === this.sessionRegistry.focused());
  }

  // --- Dépôt du Finder : événements fenêtre, routés vers le panneau visé ---

  private listenDragDrop(): void {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          const pane = this.paneAtPhysical(event.payload.position);
          for (const candidate of this.serverPanes()) {
            candidate.setDropActive(candidate === pane);
          }
        } else if (event.payload.type === 'leave') {
          this.clearDropActive();
        } else {
          const pane = this.paneAtPhysical(event.payload.position);
          this.clearDropActive();
          if (pane) {
            void this.uploadDropped(pane.session(), event.payload.paths);
          }
        }
      })
      .then((unlisten) => this.destroyRef.onDestroy(unlisten));
  }

  private clearDropActive(): void {
    for (const pane of this.serverPanes()) {
      pane.setDropActive(false);
    }
  }

  /** Le panneau serveur sous cette position (pixels physiques), s'il y en a un. */
  private paneAtPhysical(position: { x: number; y: number }): ServerPane | undefined {
    const x = position.x / window.devicePixelRatio;
    const y = position.y / window.devicePixelRatio;
    return this.serverPanes().find((pane) => {
      const rect = pane.element.nativeElement.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
  }

  private async uploadDropped(session: Session, paths: string[]): Promise<void> {
    if (!session.sftp.connected() || paths.length === 0) {
      return;
    }
    if (session.sftp.protection() === 'readonly') {
      session.sftp.reportError('Serveur en lecture seule : dépôt refusé.');
      return;
    }
    // Séquentiel : un seul dialogue « écraser ? » à la fois.
    let anyDone = false;
    for (const path of paths) {
      const name = path.split('/').pop() ?? path;
      if (await this.actions.uploadWithGuard(session, path, session.sftp.pathTo(name), name)) {
        anyDone = true;
      }
    }
    if (anyDone) {
      await session.sftp.refresh();
    }
  }

  // --- Panneau local : ouverture, envoi, menus ---

  protected openLocalDir(entry: FileEntry): void {
    void this.localFs.openDir(entry.name);
  }

  /** Envoie un fichier local vers le dossier serveur de la session focalisée. */
  protected async upload(entry: FileEntry): Promise<void> {
    const session = this.focusedSession();
    const done = await this.actions.uploadWithGuard(
      session,
      this.localFs.pathTo(entry.name),
      session.sftp.pathTo(entry.name),
      entry.name,
    );
    if (done) {
      await session.sftp.refresh();
    }
  }

  /** Envoie la sélection du panneau local vers le serveur. */
  private async uploadSelection(): Promise<void> {
    const session = this.focusedSession();
    for (const entry of this.localFs.selectedEntries().filter((e) => !e.isDir)) {
      await this.actions.uploadWithGuard(
        session,
        this.localFs.pathTo(entry.name),
        session.sftp.pathTo(entry.name),
        entry.name,
      );
    }
    await session.sftp.refresh();
  }

  protected openLocalEntryMenu(event: MouseEvent, entry: FileEntry): void {
    const first: ContextMenuItem = entry.isDir
      ? { label: 'Ouvrir', icon: 'folder', action: () => void this.localFs.openDir(entry.name) }
      : { label: 'Envoyer vers le serveur', icon: 'upload', action: () => void this.upload(entry) };
    this.contextMenu.open(event, [
      first,
      { divider: true, label: '' },
      { label: 'Copier le nom', icon: 'copy', action: () => this.actions.copyPath(entry.name) },
      {
        label: 'Copier le chemin',
        icon: 'copy',
        action: () => this.actions.copyPath(this.localFs.pathTo(entry.name)),
      },
      { divider: true, label: '' },
      {
        label: 'Renommer…',
        icon: 'pencil',
        action: () => void this.actions.renameEntry(this.localFs, entry),
      },
      {
        label: 'Supprimer définitivement',
        icon: 'trash',
        danger: true,
        action: () => void this.actions.deleteEntry(this.localFs, entry),
      },
    ]);
  }

  protected openLocalAreaMenu(event: MouseEvent): void {
    this.contextMenu.open(event, [
      {
        label: 'Nouveau dossier…',
        icon: 'folder-plus',
        action: () => void this.actions.createDirIn(this.localFs, 'Nouveau dossier local'),
      },
      {
        label: 'Nouveau fichier…',
        icon: 'file',
        action: () => void this.actions.createFileIn(this.localFs, 'Nouveau fichier local'),
      },
      { label: 'Actualiser', icon: 'refresh', action: () => void this.localFs.refresh() },
    ]);
  }

  private withoutHidden(entries: FileEntry[]): FileEntry[] {
    return this.settings.showHidden()
      ? entries
      : entries.filter((entry) => !entry.name.startsWith('.'));
  }

  // --- Le glissé venu d'une AUTRE fenêtre (relais backend) ---

  private listenForeignDrag(): void {
    const subscribe = <T,>(name: string, handler: (payload: T) => void) => {
      void listen<T>(name, (event) => handler(event.payload)).then((unlisten) =>
        this.destroyRef.onDestroy(unlisten),
      );
    };
    subscribe<{ x: number; y: number; text: string | null }>('flotte:drag-over', (at) => {
      const pane = this.paneAtClient(at.x, at.y);
      if (!pane || !this.canReceiveForeignDrop(pane.session())) {
        this.foreignLabel.set(null);
        this.clearForeignHints();
        return;
      }
      this.foreignLabel.set({ text: at.text ?? 'Déposer', x: at.x, y: at.y });
      for (const candidate of this.serverPanes()) {
        if (candidate === pane) {
          candidate.foreignOver(at.x, at.y);
        } else {
          candidate.foreignClear();
        }
      }
    });
    subscribe<void>('flotte:drag-leave', () => {
      this.foreignLabel.set(null);
      this.clearForeignHints();
    });
    subscribe<{ x: number; y: number; payload: ForeignDrop }>('flotte:drop', (drop) => {
      this.foreignLabel.set(null);
      this.clearForeignHints();
      const pane = this.paneAtClient(drop.x, drop.y) ?? this.focusedPane();
      const session = pane?.session();
      if (!pane || !session || !this.canReceiveForeignDrop(session)) {
        this.dialogToasts.error(
          session && session.sftp.protection() === 'readonly'
            ? 'Cette session est en lecture seule.'
            : 'Le dépôt entre fenêtres demande une session SFTP.',
        );
        return;
      }
      void session.clipboard.receiveDrop(drop.payload, pane.dropPathAt(drop.x, drop.y));
    });
  }

  private clearForeignHints(): void {
    for (const pane of this.serverPanes()) {
      pane.foreignClear();
    }
  }

  /** Le panneau serveur sous ce point (coordonnées client logiques). */
  private paneAtClient(x: number, y: number): ServerPane | undefined {
    const element = this.document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>('[data-session-pane]');
    if (!element) {
      return undefined;
    }
    return this.serverPanes().find((pane) => pane.element.nativeElement === element);
  }

  private canReceiveForeignDrop(session: Session): boolean {
    return (
      session.sftp.connected() &&
      session.sftp.protocol() === 'sftp' &&
      session.sftp.protection() !== 'readonly'
    );
  }

  // --- Raccourcis : le vocabulaire des gestes, routé vers la session focalisée ---

  private declareShortcuts(): Shortcut[] {
    const connected = () => this.sftp.connected();
    const writable = () => this.sftp.connected() && this.sftp.protection() !== 'readonly';
    const picked = () => this.sftp.hasSelection();
    const pickedFiles = () =>
      this.sftp.selectedEntries().filter((entry) => !entry.isDir).length;

    return [
      // --- Sélection ---
      {
        keys: 'mod+a',
        label: 'Tout sélectionner (entrées visibles)',
        group: 'Sélection',
        when: connected,
        run: () => this.sftp.selectAll(),
      },
      {
        keys: 'escape',
        label: 'Vider la sélection',
        group: 'Sélection',
        when: () => picked() || this.clipboard.hasContent(),
        run: () => {
          this.sftp.clearSelection();
          this.clipboard.clear();
        },
      },
      {
        keys: 'mod+c',
        label: 'Copier la sélection',
        group: 'Fichiers',
        when: () => connected() && picked() && this.sftp.protocol() === 'sftp',
        run: () => this.clipboard.copy(this.sftp.selectedEntries()),
      },
      {
        keys: 'mod+x',
        label: 'Couper la sélection',
        group: 'Fichiers',
        when: () => writable() && picked() && this.sftp.protocol() === 'sftp',
        run: () => this.clipboard.cut(this.sftp.selectedEntries()),
      },
      {
        keys: 'mod+v',
        label: 'Coller dans ce dossier',
        group: 'Fichiers',
        when: () => writable() && this.clipboard.hasContent(),
        run: () => void this.clipboard.pasteHere(),
      },

      // --- Naviguer ---
      {
        keys: 'mod+arrowup',
        label: 'Dossier parent',
        group: 'Naviguer',
        when: () => connected() && !this.sftp.atRoot(),
        run: () => void this.sftp.navigateUp(),
      },
      {
        keys: 'mod+r',
        label: 'Actualiser le dossier',
        group: 'Naviguer',
        when: connected,
        run: () => void this.sftp.refresh(),
      },
      {
        // Une lettre, et non `mod+shift+.` : sur un clavier français le point
        // s'obtient déjà avec Shift, donc ⌘. et ⌘⇧. seraient le même geste et
        // celui-ci volerait l'annulation des transferts. `h` pour « hidden »,
        // et `shift` parce que ⌘H masque l'application sur macOS.
        keys: 'mod+shift+h',
        label: 'Afficher les fichiers cachés',
        group: 'Naviguer',
        run: () => this.settings.update({ showHidden: !this.settings.showHidden() }),
      },
      {
        keys: 'mod+f',
        label: 'Filtrer le dossier, ou chercher dans le fichier ouvert',
        group: 'Naviguer',
        when: connected,
        run: () => {
          // Un seul point de décision : l'aperçu au premier plan avec un
          // fichier texte prend la touche, sinon c'est le filtre du dossier.
          // Deux écouteurs pour ⌘F tireraient tous les deux.
          const inPreview =
            this.dock.activePanels().has('preview') &&
            this.preview.kind() === 'text' &&
            !this.preview.markdownView();
          if (inPreview) {
            this.previewPanel()?.openFind();
          } else {
            this.focusedPane()?.toggleServerFilter();
          }
        },
      },
      {
        keys: 'mod+shift+f',
        label: 'Chercher récursivement sur le serveur',
        group: 'Naviguer',
        when: connected,
        run: () => {
          this.searchService.seed('');
          this.dock.openPanel('search');
        },
      },
      {
        keys: 'mod+shift+g',
        label: 'Aller à un chemin',
        group: 'Naviguer',
        when: connected,
        run: () => {
          this.palette.setQuery('/');
          this.palette.toggle();
        },
      },

      // --- Fichiers ---
      {
        keys: 'f2',
        label: 'Renommer',
        group: 'Fichiers',
        when: () => writable() && this.sftp.selectionCount() === 1,
        run: () => void this.renameSelection(),
      },
      {
        keys: 'mod+enter',
        label: 'Renommer (variante)',
        group: 'Fichiers',
        when: () => writable() && this.sftp.selectionCount() === 1,
        run: () => void this.renameSelection(),
      },
      {
        keys: 'mod+backspace',
        label: 'Mettre la sélection à la corbeille',
        group: 'Fichiers',
        when: () => writable() && picked() && this.trash.available(),
        run: () =>
          void this.actions.trashSelection(this.focusedSession(), this.sftp.selectedEntries()),
      },
      {
        keys: 'mod+shift+backspace',
        label: 'Supprimer définitivement',
        group: 'Fichiers',
        when: () => writable() && picked(),
        run: () => void this.actions.deleteSelection(this.focusedSession()),
      },
      {
        keys: 'mod+shift+n',
        label: 'Nouveau dossier',
        group: 'Fichiers',
        when: writable,
        run: () => void this.actions.createDirIn(this.sftp, 'Nouveau dossier sur le serveur'),
      },
      {
        keys: 'mod+s',
        label: 'Enregistrer le fichier ouvert',
        group: 'Fichiers',
        // On est dans le textarea de l'éditeur : la touche doit tirer là.
        evenWhileTyping: true,
        when: () => this.preview.canSave(),
        run: () => void this.preview.save(),
      },

      // --- Transférer ---
      {
        keys: 'mod+d',
        label: 'Télécharger la sélection',
        group: 'Transférer',
        when: () => picked() && pickedFiles() > 0,
        run: () => void this.actions.downloadSelection(this.focusedSession()),
      },
      {
        keys: 'mod+u',
        label: 'Envoyer la sélection locale',
        group: 'Transférer',
        when: () => writable() && this.localFs.hasSelection(),
        run: () => void this.uploadSelection(),
      },
      {
        keys: 'mod+.',
        label: 'Annuler les transferts en cours',
        group: 'Transférer',
        when: () => this.transfers.activeCount() > 0,
        run: () => this.transfers.cancelAll(),
      },

      // --- Panneaux ---
      {
        keys: 'control+`',
        label: 'Ouvrir le terminal',
        group: 'Panneaux',
        when: () => connected() && this.sftp.protocol() === 'sftp',
        run: () => this.dock.openPanel('terminal'),
      },
      {
        keys: 'mod+b',
        label: 'Afficher ou masquer l’arborescence',
        group: 'Panneaux',
        when: connected,
        run: () =>
          this.dock.activePanels().has('tree')
            ? this.dock.closePanel('tree')
            : this.dock.openPanel('tree'),
      },
      {
        keys: 'mod+w',
        label: 'Fermer l’onglet',
        group: 'Application',
        when: connected,
        // Ferme la SESSION focalisée (bilan compris) ; la dernière ferme la
        // fenêtre par le chemin du feu rouge.
        run: () => void this.tabBar.closeSession(this.sessionRegistry.focused().id),
      },
      ...PANEL_ORDER.map((panel, index) => ({
        keys: `mod+${index + 1}`,
        label: `Panneau ${PANEL_META[panel].label}`,
        group: 'Panneaux',
        when: connected,
        run: () => this.dock.openPanel(panel),
      })),
    ];
  }

  /** Renomme l'unique entrée sélectionnée de la session focalisée. */
  private async renameSelection(): Promise<void> {
    const entry = this.sftp.selectedEntries()[0];
    if (entry) {
      await this.actions.renameEntry(this.sftp, entry);
    }
  }

  // --- Fermeture ---

  /**
   * Ferme la fenêtre, bilan de session compris : le feu rouge passe par ici.
   * Les sessions sont déconnectées proprement avant que la fenêtre meure,
   * sinon le reaper d'inactivité garderait des connexions fantômes sur les
   * serveurs pendant un quart d'heure.
   */
  protected async requestClose(): Promise<void> {
    // CHAQUE session connectée passe par son bilan, la focalisée d'abord :
    // fermer la fenêtre ferme tous les serveurs, pas seulement celui qu'on
    // regarde. Celles qui n'ont rien à raconter ne posent aucune question
    // (confirmLeave part sans cérémonie), et un seul refus suffit à rester.
    const focused = this.sessionRegistry.focused();
    const connected = [
      focused,
      ...this.sessionRegistry.sessions().filter((session) => session !== focused),
    ].filter((session) => session.sftp.connected());
    for (const session of connected) {
      if (!(await this.recap.confirmLeave(session))) {
        return;
      }
    }
    for (const session of connected) {
      await session.sftp.disconnect();
    }
    void getCurrentWebviewWindow().destroy();
  }

  /**
   * Débarquer, avec le bilan de ce qu'on laisse derrière (idée 06). La
   * cérémonie vit dans SessionRecapService : la fermeture d'un onglet de
   * session passe par la même porte.
   */
  protected async disconnect(): Promise<void> {
    if (await this.recap.confirmLeave(this.sessionRegistry.focused())) {
      await this.sftp.disconnect();
    }
  }
}
