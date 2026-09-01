import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Button } from '@app/components/ui/button/button';
import { ToolButton } from '@app/components/ui/tool-button/tool-button';
import { MarkdownView } from '@app/components/panels/preview-panel/markdown-view';
import { Icon } from '@app/components/ui/icon/icon';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { Session, SessionRegistry } from '@app/services/connection/session-registry';
import { SplitRow, diffStats, lineDiff, toSplitRows } from '@app/services/files/diff';
import { FileActionsService } from '@app/services/files/file-actions.service';
import { toOctal } from '@app/services/files/permissions';
import { PreviewDoc, PreviewService } from '@app/services/files/preview.service';
import { ComparePickService } from '@app/services/files/compare-pick.service';
import { TabBarService } from '@app/services/workspace/tab-bar.service';
import { injectT } from '@app/lang/i18n.service';

const MARKDOWN_VIEWS: readonly SegmentedOption[] = [
  { value: 'rendered', label: 'Aperçu' },
  { value: 'source', label: 'Source' },
];

/** Taille max lue de chaque côté pour le diff entre sessions (256 Kio). */
const DIFF_MAX_BYTES = 256 * 1024;

/** Un onglet de l'aperçu : un document, et la session qui le porte. */
interface DocRow {
  session: Session;
  doc: PreviewDoc;
}

/** Le diff entre le document actif et un fichier d'une autre session. */
interface SessionDiff {
  other: Session;
  /** Le chemin comparé côté `other` (souvent le même, pas toujours). */
  otherPath: string;
  rows: SplitRow[];
  added: number;
  removed: number;
  missing: boolean;
  identical: boolean;
}

/**
 * Panneau d'aperçu v2 : des onglets de fichiers (toutes sessions confondues,
 * pastille de couleur à l'appui), un en-tête qui raconte le fichier, une
 * gouttière de numéros de ligne, le diff du même chemin entre deux serveurs,
 * et des médias soignés.
 */
@Component({
  selector: 'app-preview-panel',
  imports: [Button, Icon, MarkdownView, SegmentedControl, ToolButton, FileSizePipe],
  templateUrl: './preview-panel.html',
  styleUrl: './preview-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ⌘F est routé par ExplorerPage : dans l'aperçu il cherche dans le fichier,
  // ailleurs il filtre le dossier.
})
export class PreviewPanel {
  protected readonly t = injectT();
  protected readonly sessionRegistry = inject(SessionRegistry);
  private readonly localFs = inject(LocalFsService);
  private readonly actions = inject(FileActionsService);
  private readonly tabBar = inject(TabBarService);
  protected readonly comparePick = inject(ComparePickService);
  protected readonly markdownViews = MARKDOWN_VIEWS;

  protected get preview(): PreviewService {
    return this.sessionRegistry.previewOwner().preview;
  }

  private owner(): Session {
    return this.sessionRegistry.previewOwner();
  }

  private readonly highlightEl = viewChild<ElementRef<HTMLElement>>('hl');
  private readonly occEl = viewChild<ElementRef<HTMLElement>>('occ');
  private readonly gutterEl = viewChild<ElementRef<HTMLElement>>('gutter');
  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private readonly findField = viewChild<ElementRef<HTMLInputElement>>('findField');

  // ---------- Onglets ----------

  /** Tous les documents ouverts, toutes sessions, dans l'ordre d'ouverture. */
  protected readonly tabRows = computed<DocRow[]>(() =>
    this.sessionRegistry
      .sessions()
      .flatMap((session) => session.preview.docs().map((doc) => ({ session, doc })))
      .sort((a, b) => a.doc.seq - b.doc.seq),
  );

  protected readonly multiSession = computed(() => this.sessionRegistry.sessions().length > 1);

  protected isActiveTab(row: DocRow): boolean {
    const owner = this.sessionRegistry.previewOwner();
    return row.session === owner && row.doc.id === owner.preview.activeId();
  }

  protected activateTab(row: DocRow): void {
    row.session.preview.activate(row.doc.id);
  }

  protected closeTab(event: MouseEvent, row: DocRow): void {
    event.stopPropagation();
    void row.session.preview.closeDoc(row.doc.id);
  }

  protected tabTone(row: DocRow): string {
    return `var(--session-${this.sessionRegistry.toneOf(row.session)})`;
  }

  protected tabTitle(row: DocRow): string {
    return `${row.doc.path} · ${this.tabBar.titleOf(row.session)}`;
  }

  // ---------- En-tête riche ----------

  /** Le dossier du fichier, raccourci : le nom porte l'essentiel. */
  protected readonly dirOf = computed(() => {
    const path = this.preview.path();
    const cut = path.lastIndexOf('/');
    return cut <= 0 ? '/' : path.slice(0, cut + 1);
  });

  protected readonly modeOctal = computed(() => {
    const mode = this.preview.fileMode();
    return mode === undefined ? '' : toOctal(mode);
  });

  /** L'âge du fichier, en mots : la colonne est étroite. */
  protected readonly ageLabel = computed(() => {
    const mtime = this.preview.fileMtime();
    if (!mtime) {
      return '';
    }
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - mtime);
    if (seconds < 60) {
      return 'à l’instant';
    }
    if (seconds < 3600) {
      return `il y a ${Math.floor(seconds / 60)} min`;
    }
    if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      return `il y a ${hours} h`;
    }
    const days = Math.floor(seconds / 86400);
    if (days === 1) {
      return 'hier';
    }
    if (days < 30) {
      return `il y a ${days} j`;
    }
    return new Date(mtime * 1000).toLocaleDateString();
  });

  protected openSystemEditor(): void {
    void this.owner().remoteEdit.start(this.preview.path(), this.preview.name());
  }

  protected download(): void {
    const owner = this.owner();
    void owner.transfers
      .download(this.preview.path(), this.localFs.pathTo(this.preview.name()), this.preview.name())
      .then((done) => {
        if (done) {
          void this.localFs.refresh();
        }
      });
  }

  protected copyPath(): void {
    this.actions.copyPath(this.preview.path());
  }

  // ---------- Diff entre sessions (le fruit de la flotte) ----------

  protected readonly diff = signal<SessionDiff | null>(null);

  protected sessionTitle(session: Session): string {
    return this.tabBar.titleOf(session);
  }

  protected sessionTone(session: Session): string {
    return `var(--session-${this.sessionRegistry.toneOf(session)})`;
  }

  /**
   * Le mode « sélection » : armé, le prochain fichier cliqué dans un panneau
   * serveur (n'importe quelle session, la même comprise) est comparé au
   * fichier ouvert. On désigne avec le vrai explorateur, Échap annule.
   */
  protected async onCompare(): Promise<void> {
    const pick = await this.comparePick.request();
    if (pick) {
      await this.compareWith(pick.session, pick.path);
    }
  }

  private async compareWith(other: Session, otherPath = this.preview.path()): Promise<void> {
    const mine = this.preview.content();
    const theirs = await other.sftp.readText(otherPath, DIFF_MAX_BYTES);
    if (theirs === undefined) {
      this.diff.set({
        other,
        otherPath,
        rows: [],
        added: 0,
        removed: 0,
        missing: true,
        identical: false,
      });
      return;
    }
    const lines = lineDiff(mine, theirs);
    if (!lines) {
      this.diff.set({
        other,
        otherPath,
        rows: [],
        added: 0,
        removed: 0,
        missing: false,
        identical: false,
      });
      return;
    }
    const stats = diffStats(lines);
    this.diff.set({
      other,
      otherPath,
      rows: toSplitRows(lines),
      added: stats.added,
      removed: stats.removed,
      missing: false,
      identical: stats.added === 0 && stats.removed === 0,
    });
  }

  /** Le nom du fichier comparé en face, s'il diffère du nôtre. */
  protected otherLabel(diff: SessionDiff): string {
    if (diff.otherPath === this.preview.path()) {
      return this.sessionTitle(diff.other);
    }
    const cut = diff.otherPath.lastIndexOf('/');
    return `${this.sessionTitle(diff.other)} · ${diff.otherPath.slice(cut + 1)}`;
  }

  protected exitDiff(): void {
    this.diff.set(null);
  }

  // ---------- Gouttière ----------

  private readonly lineCount = computed(() => {
    const content = this.preview.content();
    let lines = 1;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) {
        lines++;
      }
    }
    return lines;
  });

  /** Ne se refabrique que quand le NOMBRE de lignes change, pas à chaque frappe. */
  protected readonly gutterText = computed(() =>
    Array.from({ length: this.lineCount() }, (_, i) => i + 1).join('\n'),
  );

  // ---------- Médias ----------

  protected readonly imageZoom = signal<'fit' | number>('fit');
  protected readonly imageDims = signal<{ w: number; h: number } | null>(null);

  protected onImageLoad(img: HTMLImageElement): void {
    this.imageDims.set({ w: img.naturalWidth, h: img.naturalHeight });
  }

  protected readonly imageWidth = computed(() => {
    const zoom = this.imageZoom();
    const dims = this.imageDims();
    return zoom === 'fit' || !dims ? null : Math.round(dims.w * zoom);
  });

  protected readonly zoomLabel = computed(() => {
    const zoom = this.imageZoom();
    return zoom === 'fit' ? 'ajusté' : `${Math.round(zoom * 100)} %`;
  });

  protected zoomIn(): void {
    const current = this.imageZoom();
    this.imageZoom.set(Math.min(8, (current === 'fit' ? 1 : current) * 1.25));
  }

  protected zoomOut(): void {
    const current = this.imageZoom();
    this.imageZoom.set(Math.max(0.1, (current === 'fit' ? 1 : current) / 1.25));
  }

  protected zoomReset(): void {
    this.imageZoom.set(1);
  }

  protected zoomFit(): void {
    this.imageZoom.set('fit');
  }

  // ---------- Recherche, défilement, markdown (inchangés) ----------

  /** Ce que le compteur de la barre raconte. */
  protected readonly findCount = computed(() => {
    if (this.preview.findInvalid()) {
      return 'motif invalide';
    }
    if (!this.preview.findQuery()) {
      return '';
    }
    const total = this.preview.findMatches().length;
    if (!total) {
      return 'aucun résultat';
    }
    const cap = this.preview.findCapped() ? '+' : '';
    return `${this.preview.findIndex() + 1} sur ${total}${cap}`;
  });

  constructor() {
    // L'occurrence courante se montre : le défilement attend le rendu de la
    // couche, c'est la marque dans le DOM qui donne les coordonnées exactes.
    effect(() => {
      if (this.preview.currentMatch()) {
        setTimeout(() => this.scrollToCurrent());
      }
    });
    // Saut sans occurrence (le motif n'est plus dans le fichier) : à la ligne.
    effect(() => {
      const jump = this.preview.jumpLine();
      if (jump) {
        setTimeout(() => this.scrollToLine(jump.line));
      }
    });
    // Changer de document range le diff et remet le zoom : ils racontaient
    // l'ancien fichier.
    effect(() => {
      const owner = this.sessionRegistry.previewOwner();
      owner.preview.activeId();
      untracked(() => {
        this.diff.set(null);
        this.comparePick.settle(null);
        this.imageZoom.set('fit');
        this.imageDims.set(null);
      });
    });
  }

  /** Appelé par le routage de ⌘F (voir ExplorerPage). */
  openFind(): void {
    if (this.preview.kind() !== 'text' || this.preview.markdownView()) {
      return;
    }
    this.preview.openFind();
    // Le champ vient peut-être d'apparaître : le focus attend son rendu.
    setTimeout(() => {
      const field = this.findField()?.nativeElement;
      field?.focus();
      field?.select();
    });
  }

  protected onFindKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.preview.findPrev();
      } else {
        this.preview.findNext();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.preview.closeFind();
      this.inputEl()?.nativeElement.focus();
    }
  }

  /** Aligne les couches (occurrences, coloration, gouttière) sur le textarea. */
  protected syncScroll(event: Event): void {
    this.syncLayers(event.target as HTMLTextAreaElement);
  }

  private syncLayers(source: HTMLTextAreaElement): void {
    for (const layer of [this.highlightEl()?.nativeElement, this.occEl()?.nativeElement]) {
      if (layer) {
        layer.scrollTop = source.scrollTop;
        layer.scrollLeft = source.scrollLeft;
      }
    }
    const gutter = this.gutterEl()?.nativeElement;
    if (gutter) {
      gutter.scrollTop = source.scrollTop;
    }
  }

  private scrollToCurrent(): void {
    const mark = this.occEl()?.nativeElement.querySelector<HTMLElement>('.occ--now');
    const input = this.inputEl()?.nativeElement;
    if (!mark || !input) {
      return;
    }
    const { offsetTop, offsetLeft } = mark;
    // On ne recentre que si l'occurrence est hors de vue : garder l'écran
    // stable pendant qu'on enchaîne des occurrences voisines.
    if (offsetTop < input.scrollTop + 16 || offsetTop > input.scrollTop + input.clientHeight - 40) {
      input.scrollTop = Math.max(0, offsetTop - input.clientHeight / 3);
    }
    if (offsetLeft < input.scrollLeft || offsetLeft > input.scrollLeft + input.clientWidth - 80) {
      input.scrollLeft = Math.max(0, offsetLeft - input.clientWidth / 3);
    }
    this.syncLayers(input);
  }

  private scrollToLine(line: number): void {
    const input = this.inputEl()?.nativeElement;
    if (!input) {
      return;
    }
    const lines = this.preview.content().split('\n').length;
    const lineHeight = input.scrollHeight / Math.max(1, lines);
    input.scrollTop = Math.max(0, (line - 1) * lineHeight - input.clientHeight / 3);
    this.syncLayers(input);
  }

  protected onMarkdownView(value: string): void {
    this.preview.setMarkdownView(value === 'rendered');
  }
}
