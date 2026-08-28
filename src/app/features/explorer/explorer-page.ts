import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
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
import { SelectionBar } from '@app/components/panels/selection-bar/selection-bar';
import { TrashPane } from '@app/components/panels/trash-pane/trash-pane';
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
import { DockPanelId } from '@app/interfaces';
import { DockService, PANEL_META } from '@app/services/workspace/dock.service';
import { TrashService } from '@app/services/files/trash.service';
import { RecapLine, SessionRecapService } from '@app/services/workspace/session-recap.service';
import { Shortcut, ShortcutsService } from '@app/services/workspace/shortcuts.service';
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
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { FileClipboardService } from '@app/services/connection/file-clipboard.service';
import { toOctal, toSymbolic } from '@app/services/files/permissions';
import { PermissionsService } from '@app/services/files/permissions.service';
import { SearchService } from '@app/services/connection/search.service';
import { TerminalService } from '@app/services/workspace/terminal.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { TransfersService } from '@app/services/files/transfers.service';
import { UpdaterService } from '@app/services/system/updater.service';

/** Nom d'entrée valide : pas de séparateur, pas de `.` / `..`. */
/** Ce qu'une nature d'entrée du journal raconte dans le bilan de session. */
/**
 * La couleur de chaque nature dans le bilan : ce qui a été ajouté en vert, ce
 * qui a été modifié en accent, ce qui a été retiré en ambre. La pastille se
 * lit avant le texte.
 */
const SESSION_TONES: Record<string, RecapLine['tone']> = {
  upload: 'ok',
  download: 'ok',
  mkdir: 'ok',
  edit: 'accent',
  rename: 'accent',
  remove: 'warn',
  cancel: 'warn',
  resume: 'accent',
  module: 'accent',
};

/** Le chemin raccourci à ses deux derniers segments : la colonne est étroite. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

const SESSION_LABELS: Record<string, (n: number) => string> = {
  upload: (n) => `fichier${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''}`,
  download: (n) => `fichier${n > 1 ? 's' : ''} téléchargé${n > 1 ? 's' : ''}`,
  edit: (n) => `fichier${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''}`,
  remove: (n) => `élément${n > 1 ? 's' : ''} supprimé${n > 1 ? 's' : ''}`,
  rename: (n) => `élément${n > 1 ? 's' : ''} renommé${n > 1 ? 's' : ''} ou déplacé${n > 1 ? 's' : ''}`,
  mkdir: (n) => `dossier${n > 1 ? 's' : ''} créé${n > 1 ? 's' : ''}`,
  resume: (n) => `transfert${n > 1 ? 's' : ''} repris`,
  cancel: (n) => `transfert${n > 1 ? 's' : ''} annulé${n > 1 ? 's' : ''}`,
  module: (n) => `action${n > 1 ? 's' : ''} de module`,
};

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
 * Un fichier créé sans extension en reçoit une : `.txt`.
 *
 * Le point compte, pas sa position : `.env` et `.gitignore` ont bien un point
 * et restent tels quels — ce sont des fichiers cachés, pas des fichiers sans
 * extension. Un nom vraiment nu (`notes`, `Dockerfile`) devient `notes.txt`,
 * et c'est annoncé dans le dialogue pour que personne ne soit surpris.
 */
function withDefaultExtension(name: string): string {
  return name.includes('.') ? name : `${name}.txt`;
}

/** Au-delà, un mouvement souris devient un glissé et non plus un clic. */
const DRAG_THRESHOLD = 5;

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
    SelectionBar,
    TrashPane,
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
  protected readonly clipboard = inject(FileClipboardService);
  private readonly activity = inject(ActivityLogService);
  private readonly document = inject(DOCUMENT);
  private readonly shortcuts = inject(ShortcutsService);
  private readonly recap = inject(SessionRecapService);
  private readonly trash = inject(TrashService);
  /** Le panneau d'aperçu, pour lui router ⌘F quand il est au premier plan. */
  private readonly previewPanel = viewChild(PreviewPanel);
  protected readonly permissions = inject(PermissionsService);
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

  /**
   * La rangée de filtre ne s'affiche qu'à la demande : un champ permanent
   * mange une ligne du panneau pour un geste occasionnel. La fermer VIDE le
   * filtre : une liste réduite par un filtre invisible serait un piège.
   */
  protected readonly serverFilterOpen = signal(false);
  private readonly serverFilterField = viewChild<ElementRef<HTMLInputElement>>('serverFilter');

  /** Ce que le filtre laisse passer, sur ce que le dossier compte vraiment. */
  protected readonly serverFilterCount = computed(() => {
    const total = this.withoutHidden(this.sftp.entries()).length;
    return `${this.serverEntries().length} sur ${total}`;
  });

  protected toggleServerFilter(): void {
    if (this.serverFilterOpen()) {
      this.closeServerFilter();
      return;
    }
    this.serverFilterOpen.set(true);
    setTimeout(() => this.serverFilterField()?.nativeElement.focus());
  }

  protected closeServerFilter(): void {
    this.serverFilterOpen.set(false);
    this.sftp.filter.set('');
    this.sftp.kindFilter.set('all');
  }

  /** Échap en deux temps : une saisie se vide, un champ vide se ferme. */
  protected onServerFilterEscape(): void {
    if (this.sftp.filter()) {
      this.sftp.filter.set('');
    } else {
      this.closeServerFilter();
    }
  }

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
    this.destroyRef.onDestroy(this.shortcuts.register(this.declareShortcuts()));

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

  // --- Sélection multiple (idée 01) ---

  /**
   * Déplacement par glissé, en événements POINTEUR et non en drag HTML5.
   *
   * Tauri branche le drag & drop natif de la webview pour recevoir les
   * fichiers déposés depuis le Finder (`onDragDropEvent`), et ce handler natif
   * **avale les événements `dragover`/`drop` du DOM** : un glissé HTML5 part
   * bien mais ne se dépose nulle part. Les événements pointeur, eux, ne
   * passent pas par là.
   *
   * Le glissé ne démarre qu'au-delà d'un seuil : un clic simple doit rester un
   * clic, et le double-clic doit continuer d'ouvrir.
   */
  protected readonly dropTargetDir = signal<string | null>(null);

  /** L'étiquette qui suit le curseur : sans elle, le geste ne se voit pas. */
  protected readonly dragLabel = signal<{ text: string; x: number; y: number } | null>(null);

  private dragged: FileEntry[] = [];
  private dragOrigin: { x: number; y: number; entry: FileEntry } | null = null;
  private dragging = false;

  protected onEntryPointerDown(event: PointerEvent, entry: FileEntry): void {
    // Bouton gauche seulement, et jamais en lecture seule ou en FTP (le
    // déplacement passe par un rename SFTP).
    if (
      event.button !== 0 ||
      this.sftp.protection() === 'readonly' ||
      this.sftp.protocol() !== 'sftp'
    ) {
      return;
    }
    this.dragOrigin = { x: event.clientX, y: event.clientY, entry };
    this.document.addEventListener('pointermove', this.onPointerMove);
    this.document.addEventListener('pointerup', this.onPointerUp, { once: true });
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const origin = this.dragOrigin;
    if (!origin) {
      return;
    }
    if (!this.dragging) {
      const moved = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
      if (moved < DRAG_THRESHOLD) {
        return;
      }
      this.dragging = true;
      // Traîner une ligne hors sélection déplace CETTE ligne, pas la
      // sélection qu'on avait oubliée ailleurs.
      if (!this.sftp.isSelected(origin.entry.name)) {
        this.sftp.selectOnly(origin.entry.name);
      }
      this.dragged = this.sftp.selectedEntries();
      this.document.body.classList.add('is-dragging');
    }

    const what =
      this.dragged.length === 1 ? this.dragged[0].name : `${this.dragged.length} éléments`;
    // Le geste dit ce qu'il fera : déplacer, ou copier si ⌥ est enfoncé.
    const label = event.altKey ? `Copier ${what}` : what;
    this.dragLabel.set({ text: label, x: event.clientX, y: event.clientY });
    this.dropTargetDir.set(this.dirUnderPointer(event));
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.document.removeEventListener('pointermove', this.onPointerMove);
    this.document.body.classList.remove('is-dragging');
    const entries = this.dragged;
    const wasDragging = this.dragging;
    const target = this.dropTargetDir();

    this.dragOrigin = null;
    this.dragging = false;
    this.dragged = [];
    this.dragLabel.set(null);
    this.dropTargetDir.set(null);

    if (!wasDragging || !entries.length) {
      return;
    }
    // Le fil d'Ariane est une cible aussi : c'est le geste « remonter d'un cran ».
    const crumb = this.crumbUnderPointer(event);
    const destination = crumb ?? (target ? this.sftp.pathTo(target) : null);
    if (destination) {
      // ⌥ pendant le dépôt : copier au lieu de déplacer, comme dans un Finder.
      void this.clipboard
        .moveInto(entries, destination, event.altKey)
        .then(() => this.sftp.clearSelection());
    }
  };

  /** Le dossier de la liste sous le curseur, s'il en accepte le dépôt. */
  private dirUnderPointer(event: PointerEvent): string | null {
    const row = this.document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-entry]');
    const name = row?.dataset['entry'];
    if (!name || row?.dataset['dir'] !== 'true') {
      return null;
    }
    // Un dossier qu'on traîne ne peut pas être sa propre destination.
    return this.sftp.isSelected(name) ? null : name;
  }

  /** Le segment de fil d'Ariane sous le curseur, s'il y en a un. */
  private crumbUnderPointer(event: PointerEvent): string | null {
    const crumb = this.document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-crumb]');
    const path = crumb?.dataset['crumb'];
    return path && path !== this.sftp.currentPath() ? path : null;
  }

  /**
   * Le vocabulaire des gestes (idée 08), déclaré en un endroit plutôt qu'en
   * écouteurs éparpillés : c'est ce qui permet d'en montrer la liste (⌘/) et
   * de voir d'un coup d'œil si deux touches se marchent dessus.
   *
   * Les raccourcis de sélection restent sur la liste elle-même : ils n'ont de
   * sens que le focus dedans, et ⌘A doit sélectionner le texte ailleurs.
   */
  private declareShortcuts(): Shortcut[] {
    const connected = () => this.sftp.connected();
    const writable = () => this.sftp.connected() && this.sftp.protection() !== 'readonly';
    const picked = () => this.sftp.hasSelection();

    return [
      // --- Sélection ---
      //
      // Dans le registre et non sur la liste : sinon ⌘A ne tire que le focus
      // dedans, et tombe partout ailleurs sur le « tout sélectionner » natif
      // de la webview.
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
            this.toggleServerFilter();
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
        run: () => void this.trashSelection(this.sftp.selectedEntries()),
      },
      {
        keys: 'mod+shift+backspace',
        label: 'Supprimer définitivement',
        group: 'Fichiers',
        when: () => writable() && picked(),
        run: () => void this.deleteSelection(),
      },
      {
        keys: 'mod+shift+n',
        label: 'Nouveau dossier',
        group: 'Fichiers',
        when: writable,
        run: () => void this.createDirIn(this.sftp, 'Nouveau dossier sur le serveur'),
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
        when: () => picked() && this.selectedFileCount() > 0,
        run: () => void this.downloadSelection(),
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
        label: 'Fermer le panneau actif',
        group: 'Panneaux',
        when: connected,
        run: () => this.closeFocusedPanel(),
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

  /** Renomme l'unique entrée sélectionnée. */
  private async renameSelection(): Promise<void> {
    const entry = this.sftp.selectedEntries()[0];
    if (entry) {
      await this.renameEntry(this.sftp, entry);
    }
  }

  /** Envoie la sélection du panneau local vers le serveur. */
  private async uploadSelection(): Promise<void> {
    for (const entry of this.localFs.selectedEntries().filter((e) => !e.isDir)) {
      await this.uploadWithGuard(
        this.localFs.pathTo(entry.name),
        this.sftp.pathTo(entry.name),
        entry.name,
      );
    }
    await this.sftp.refresh();
  }

  /** Ferme le panneau visible le plus à droite : le dernier ouvert, en pratique. */
  private closeFocusedPanel(): void {
    const active = [...this.dock.activePanels()];
    const last = active[active.length - 1];
    if (last) {
      this.dock.closePanel(last);
    }
  }

  /** Les permissions en octal, pour la colonne de la liste (idée 07). */
  protected modeOf(entry: FileEntry): string {
    return entry.mode === undefined ? '' : toOctal(entry.mode);
  }

  protected modeTitle(entry: FileEntry): string {
    if (entry.mode === undefined) {
      return '';
    }
    const who = entry.owner ? ` · ${entry.owner}${entry.group ? `:${entry.group}` : ''}` : '';
    return `${entry.isDir ? 'd' : '-'}${toSymbolic(entry.mode)}${who}`;
  }

  /** Combien de FICHIERS dans la sélection : les dossiers ne se téléchargent pas. */
  protected readonly selectedFileCount = computed(
    () => this.sftp.selectedEntries().filter((entry) => !entry.isDir).length,
  );

  /**
   * Un clic sur une ligne du serveur, avec ses modificateurs.
   *
   * Maj étend depuis l'ancre, Cmd/Ctrl ajoute ou retire, un clic nu remplace.
   * Le double-clic garde son rôle d'ouverture : sélectionner et ouvrir sont
   * deux gestes différents, comme dans un Finder.
   */
  protected onServerClick(event: MouseEvent, entry: FileEntry): void {
    if (event.shiftKey && (event.metaKey || event.ctrlKey)) {
      // Ajoute la plage à la sélection au lieu de la remplacer.
      event.preventDefault();
      this.sftp.extendTo(entry.name, true);
      return;
    }
    if (event.shiftKey) {
      // Sans ça, une extension au Maj-clic sélectionne aussi le texte des
      // lignes traversées.
      event.preventDefault();
      this.sftp.extendTo(entry.name);
    } else if (event.metaKey || event.ctrlKey) {
      this.sftp.toggleSelection(entry.name);
    } else {
      this.sftp.selectOnly(entry.name);
    }
  }

  /**
   * Les raccourcis de sélection, quand le panneau serveur a la main.
   *
   * Ignorés si la frappe vient d'un champ (le filtre, la recherche) : Cmd+A
   * doit y sélectionner le texte, pas le dossier.
   */
  protected onServerKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea')) {
      return;
    }
    if (event.key === 'Escape') {
      this.sftp.clearSelection();
      this.clipboard.clear();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = this.sftp.neighbour(this.sftp.focused(), event.key === 'ArrowDown' ? 1 : -1);
      if (!next) {
        return;
      }
      // Maj + flèche étend la plage, la flèche seule déplace la sélection.
      if (event.shiftKey) {
        this.sftp.extendTo(next);
      } else {
        this.sftp.selectOnly(next);
      }
      this.scrollSelectionIntoView(next);
    }
  }

  /**
   * Un clic dans le vide de la liste vide la sélection : c'est le geste de
   * tous les explorateurs, et sans lui il faut viser Échap.
   */
  protected onListClick(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('[data-entry]')) {
      this.sftp.clearSelection();
    }
  }

  private scrollSelectionIntoView(name: string): void {
    setTimeout(() => {
      this.serverZone()
        .nativeElement.querySelector(`[data-entry="${CSS.escape(name)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Télécharge tout ce qui est sélectionné, fichier par fichier. */
  protected async downloadSelection(): Promise<void> {
    // Un instantané : la liste bouge sous nos pieds au fil des refresh.
    const files = this.sftp.selectedEntries().filter((entry) => !entry.isDir);
    for (const entry of files) {
      await this.transfers.download(
        this.sftp.pathTo(entry.name),
        this.localFs.pathTo(entry.name),
        entry.name,
      );
    }
    await this.localFs.refresh();
  }

  /**
   * Met une sélection à la corbeille (idée 02).
   *
   * Sans confirmation, à dessein : c'est tout l'intérêt du filet, et le toast
   * porte l'annulation. C'est la suppression DÉFINITIVE qui demande à
   * réfléchir.
   */
  private async trashSelection(entries: FileEntry[]): Promise<void> {
    if (await this.trash.trash(entries)) {
      this.sftp.clearSelection();
    }
  }

  /** Supprime la sélection, avec la confirmation qui va avec le lot. */
  protected async deleteSelection(): Promise<void> {
    const entries = this.sftp.selectedEntries();
    if (!entries.length) {
      return;
    }
    if (entries.length === 1) {
      await this.deleteEntry(this.sftp, entries[0]);
      this.sftp.clearSelection();
      return;
    }

    const dirs = entries.filter((entry) => entry.isDir).length;
    const detail = dirs
      ? `${entries.length} éléments, dont ${dirs} dossier${dirs > 1 ? 's' : ''} et tout leur contenu.`
      : `${entries.length} fichiers.`;

    // Serveur protégé : le nom d'hôte, comme pour une suppression unitaire.
    if (this.sftp.protection() === 'confirm') {
      const host = this.sftp.host();
      const typed = await this.dialog.prompt({
        title: `Serveur protégé : supprimer ${entries.length} éléments ?`,
        message: `${detail} Tape « ${host} » pour confirmer.`,
        placeholder: host,
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (typed?.trim() !== host) {
        return;
      }
    } else if (dirs > 0) {
      // Un dossier seul exige de retaper son nom : un lot QUI EN CONTIENT ne
      // doit pas être plus facile à supprimer. Le lot n'a pas de nom unique,
      // d'où le mot à taper.
      const typed = await this.dialog.prompt({
        title: `Supprimer ${entries.length} éléments, dont ${dirs} dossier${dirs > 1 ? 's' : ''} ?`,
        message: `${detail} Tape « supprimer » pour confirmer.`,
        placeholder: 'supprimer',
        confirmLabel: 'Tout supprimer',
        danger: true,
      });
      if (typed?.trim().toLowerCase() !== 'supprimer') {
        return;
      }
    } else if (
      !(await this.dialog.confirm({
        title: `Supprimer ${entries.length} fichiers ?`,
        message: `${detail} Cette action est définitive.`,
        confirmLabel: 'Supprimer',
        danger: true,
      }))
    ) {
      return;
    }

    for (const entry of entries) {
      await this.sftp.removeSilently(this.sftp.pathTo(entry.name), entry.isDir);
    }
    this.sftp.clearSelection();
    await this.sftp.refresh();
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
    // Clic droit DANS une sélection multiple : le menu porte sur le lot.
    // Clic droit dehors : la sélection repart de cette ligne, comme partout.
    if (this.sftp.selectionCount() > 1 && this.sftp.isSelected(entry.name)) {
      this.openSelectionMenu(event);
      return;
    }
    if (!this.sftp.isSelected(entry.name)) {
      this.sftp.selectOnly(entry.name);
    }
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
    if (this.sftp.protocol() === 'sftp') {
      items.push(
        { divider: true, label: '' },
        ...this.clipboardActions([entry]),
        ...this.pasteAction(),
      );
      items.push({
        label: 'Permissions…',
        icon: 'shield-check',
        action: () => this.permissions.open(entry, this.sftp.pathTo(entry.name)),
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

  /**
   * L'action « coller », proposée partout où un clic droit peut tomber : sur
   * le fond, sur une ligne, sur une sélection. Devoir viser le bord du
   * panneau pour trouver Coller était une corvée.
   *
   * Le dossier de destination est TOUJOURS le dossier courant, y compris
   * quand on a cliqué droit sur un fichier : coller « dans » un fichier n'a
   * pas de sens, et coller dans le dossier survolé serait une surprise.
   */
  private pasteAction(): ContextMenuItem[] {
    if (
      !this.clipboard.hasContent() ||
      this.sftp.protocol() !== 'sftp' ||
      this.sftp.protection() === 'readonly'
    ) {
      return [];
    }
    const count = this.clipboard.count();
    return [
      {
        label:
          this.clipboard.mode() === 'copy'
            ? `Coller ici (${count})`
            : `Déplacer ici (${count})`,
        icon: 'clipboard',
        action: () => void this.clipboard.pasteHere(),
      },
    ];
  }

  /**
   * Copier / Couper / Coller (idée 03 et déplacement). SFTP uniquement : la
   * copie passe par le canal exec, que FTP n'a pas.
   */
  private clipboardActions(entries: FileEntry[]): ContextMenuItem[] {
    const readonly = this.sftp.protection() === 'readonly';
    const what = entries.length > 1 ? ` (${entries.length})` : '';
    const items: ContextMenuItem[] = [
      {
        label: `Copier${what}`,
        icon: 'copy',
        action: () => this.clipboard.copy(entries),
      },
    ];
    if (!readonly) {
      items.push({
        label: `Couper${what}`,
        icon: 'scissors',
        action: () => this.clipboard.cut(entries),
      });
    }
    return items;
  }

  /** Le menu d'une sélection multiple : ce qui a du sens sur un lot. */
  private openSelectionMenu(event: MouseEvent): void {
    const count = this.sftp.selectionCount();
    const files = this.selectedFileCount();
    const items: ContextMenuItem[] = [];

    if (files > 0) {
      items.push({
        label: `Télécharger ${files} fichier${files > 1 ? 's' : ''}`,
        icon: 'download',
        action: () => void this.downloadSelection(),
      });
    }
    if (this.sftp.protocol() === 'sftp') {
      items.push(...this.clipboardActions(this.sftp.selectedEntries()), ...this.pasteAction());
    }
    items.push({
      label: 'Copier les chemins',
      icon: 'copy',
      action: () =>
        this.copyPath(
          this.sftp
            .selectedEntries()
            .map((entry) => this.sftp.pathTo(entry.name))
            .join('\n'),
        ),
    });
    if (this.sftp.protection() !== 'readonly') {
      items.push({ divider: true, label: '' });
      if (this.trash.available()) {
        items.push({
          label: `Mettre ${count} éléments à la corbeille`,
          icon: 'trash',
          action: () => void this.trashSelection(this.sftp.selectedEntries()),
        });
      }
      items.push({
        label: `Supprimer ${count} éléments définitivement`,
        icon: 'trash',
        danger: true,
        action: () => void this.deleteSelection(),
      });
    }
    this.contextMenu.open(event, items);
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
    const paste = this.pasteAction();
    this.contextMenu.open(event, [
      ...paste,
      ...(paste.length ? [{ divider: true, label: '' } as ContextMenuItem] : []),
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
    const items: ContextMenuItem[] = [
      { label: 'Renommer…', icon: 'pencil', action: () => void this.renameEntry(browser, entry) },
    ];
    // La corbeille passe devant : c'est le geste qu'on veut par défaut, celui
    // qui se rattrape. La suppression définitive reste juste en dessous.
    if (browser === this.sftp && this.trash.available()) {
      items.push({
        label: 'Mettre à la corbeille',
        icon: 'trash',
        action: () => void this.trashSelection([entry]),
      });
    }
    items.push({
      label: 'Supprimer définitivement',
      icon: 'trash',
      danger: true,
      action: () => void this.deleteEntry(browser, entry),
    });
    return items;
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
      await this.dialog.prompt({
        title,
        message: 'Sans extension, le fichier sera créé en .txt.',
        placeholder: 'nom-du-fichier.txt',
        confirmLabel: 'Créer',
      })
    )?.trim();
    if (name && isValidEntryName(name)) {
      await browser.mkfile(withDefaultExtension(name));
    }
  }

  private withoutHidden(entries: FileEntry[]): FileEntry[] {
    return this.settings.showHidden()
      ? entries
      : entries.filter((entry) => !entry.name.startsWith('.'));
  }

  /** Ferme la connexion ; demande confirmation si des transferts sont actifs. */
  /**
   * Débarquer, avec le bilan de ce qu'on laisse derrière (idée 06).
   *
   * La confirmation en cas de transfert actif existait déjà : ce bilan la
   * remplace en lui donnant le contexte qui lui manquait. Sur un serveur marqué
   * PROD, savoir ce qu'on vient de modifier avant de partir a de la valeur.
   *
   * Il est construit sur le journal, donc rien n'est enregistré de plus.
   */
  protected async disconnect(): Promise<void> {
    const active = this.transfers.activeCount();
    const touched = this.activity.since(this.sftp.connectedAt());

    // Session sans conséquence et sans transfert en cours : partir ne demande
    // pas de cérémonie.
    if (!active && !touched.length) {
      await this.sftp.disconnect();
      return;
    }

    const lines: RecapLine[] = touched.map((item) => ({
      kind: item.kind,
      text: `${item.count} ${SESSION_LABELS[item.kind](item.count)}`,
      where: shortPath(item.sample),
      tone: SESSION_TONES[item.kind] ?? 'accent',
    }));
    if (active) {
      lines.push({
        kind: 'transfer',
        text: `${active} transfert${active > 1 ? 's' : ''} en cours`,
        where: 'reprise possible',
        tone: 'err',
      });
    }

    const leave = await this.recap.ask({
      host: this.sftp.host(),
      address: `${this.sftp.protocol()}://${this.sftp.host()}`,
      prod: this.sftp.environment() === 'prod',
      lines,
    });
    if (leave) {
      await this.sftp.disconnect();
    }
  }
}
