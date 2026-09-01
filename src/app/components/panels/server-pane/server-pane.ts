import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { SelectionBar } from '@app/components/panels/selection-bar/selection-bar';
import { Alert } from '@app/components/ui/alert/alert';
import { Button } from '@app/components/ui/button/button';
import { Icon } from '@app/components/ui/icon/icon';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { FileEntry } from '@app/interfaces';
import { injectT } from '@app/lang/i18n.service';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { FileClipboardService } from '@app/services/connection/file-clipboard.service';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { ProfilesService } from '@app/services/connection/profiles.service';
import { Session, SessionRegistry } from '@app/services/connection/session-registry';
import { SftpService } from '@app/services/connection/sftp.service';
import { ComparePickService } from '@app/services/files/compare-pick.service';
import { DragHintService } from '@app/services/files/drag-hint.service';
import { FileActionsService } from '@app/services/files/file-actions.service';
import { toOctal, toSymbolic } from '@app/services/files/permissions';
import { PreviewService } from '@app/services/files/preview.service';
import { CommandPaletteService } from '@app/services/workspace/command-palette.service';
import { ContextMenuItem, ContextMenuService } from '@app/services/workspace/context-menu.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { DockService } from '@app/services/workspace/dock.service';

/** Au-delà, un mouvement souris devient un glissé et non plus un clic. */
const DRAG_THRESHOLD = 5;

/** Cadence d'alimentation du backend quand le glissé sort de la fenêtre. */
const DRAG_FEED_MS = 40;

/**
 * Le panneau serveur d'UNE session : listing, fil d'Ariane, filtre, sélection
 * multiple, glissé, menus contextuels.
 *
 * Extrait d'explorer-page pour la flotte v2 : la vue double, c'est simplement
 * deux instances de ce composant côte à côte, chacune liée à sa session. Le
 * glissé d'un panneau à l'autre est un glissé pointeur ordinaire : la cible
 * est retrouvée sous le curseur, et si elle appartient à une AUTRE session, le
 * dépôt passe par la machinerie du collage croisé (même serveur : cp/mv ;
 * serveurs différents : le pont), conflits compris.
 */
@Component({
  selector: 'app-server-pane',
  imports: [Alert, Button, Icon, SegmentedControl, SelectionBar, FileSizePipe],
  templateUrl: './server-pane.html',
  styleUrl: './server-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Toucher un panneau focalise sa session : c'est le focus de n'importe
    // quelle app, pas un sélecteur. Le clavier et la palette suivent.
    '(pointerdown)': 'adopt()',
    // Les deux boutons latéraux de la souris font ce qu'ils font partout
    // ailleurs : reculer et avancer dans l'historique.
    '(auxclick)': 'onAux($event)',
    '[attr.data-session-pane]': 'session().id',
    '[class.pane--picking]': 'comparePick.armed()',
  },
})
export class ServerPane {
  readonly session = input.required<Session>();

  private readonly registry = inject(SessionRegistry);
  protected readonly dragHint = inject(DragHintService);
  private readonly actions = inject(FileActionsService);
  protected readonly comparePick = inject(ComparePickService);
  private readonly toasts = inject(ToastService);
  protected readonly t = injectT();
  private readonly localFs = inject(LocalFsService);
  private readonly contextMenu = inject(ContextMenuService);
  private readonly dock = inject(DockService);
  private readonly palette = inject(CommandPaletteService);
  private readonly profiles = inject(ProfilesService);
  private readonly document = inject(DOCUMENT);
  readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Un pane peut être détruit en PLEIN glissé (bascule d'onglet au clavier,
    // dissolution du split) : ses écouteurs document survivraient jusqu'au
    // prochain pointerup, sur un composant mort. On nettoie tout à la sortie.
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('pointermove', this.onPointerMove);
      this.document.removeEventListener('pointerup', this.onPointerUp);
      this.document.removeEventListener('pointercancel', this.onPointerCancel);
      this.document.body.classList.remove('is-dragging');
      this.cancelMoveRaf();
      this.dragHint.clear();
    });
  }

  protected get sftp(): SftpService {
    return this.session().sftp;
  }

  protected get clipboard(): FileClipboardService {
    return this.session().clipboard;
  }

  private get preview(): PreviewService {
    return this.session().preview;
  }

  protected adopt(): void {
    this.registry.focus(this.session().id);
  }

  /** Boutons 3 et 4 de la souris : précédent et suivant. */
  protected onAux(event: MouseEvent): void {
    if (event.button === 3) {
      event.preventDefault();
      void this.sftp.goBack();
    } else if (event.button === 4) {
      event.preventDefault();
      void this.sftp.goForward();
    }
  }

  /** En vue double seulement : seule, la vignette radoterait. */
  protected readonly inSplit = computed(() => this.registry.displayed().length > 1);

  /** Le nom de la session, pour la vignette d'appartenance. */
  protected readonly paneTitle = computed(() => {
    const profile = this.profiles
      .profiles()
      .find((candidate) => candidate.id === this.sftp.profileId());
    return profile?.name ?? (this.sftp.host() || 'Connexion');
  });

  /** Les infobulles nomment la destination : un bouton « précédent » qui ne
   *  dit pas où il ramène oblige à essayer pour savoir. */
  protected readonly backTitle = computed(() => {
    const target = this.sftp.backTarget();
    return target ? `Retour à ${target}` : this.t('server.noPrevDir');
  });

  protected readonly forwardTitle = computed(() => {
    const target = this.sftp.forwardTarget();
    return target ? `Aller à ${target}` : this.t('server.noNextDir');
  });

  protected readonly toneColor = computed(
    () => `var(--session-${this.registry.toneOf(this.session())})`,
  );

  // --- Listing et filtre ---

  // Les fichiers cachés sont écartés par le navigateur lui-même
  // (`shownEntries`), pour que « tout sélectionner » ne porte que sur ce que
  // l'écran montre.
  protected readonly serverEntries = computed(() => this.sftp.filteredEntries());

  /** Le filtre du listing retire des lignes : dit combien, et lesquelles reviennent. */
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
    const total = this.sftp.shownEntries().length;
    return this.t('server.filterCount', { shown: this.serverEntries().length, total });
  });

  toggleServerFilter(): void {
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

  // --- Le dépôt du Finder (relayé par explorer-page, événements fenêtre) ---

  /** Un glisser-déposer de fichiers du Finder survole ce panneau. */
  protected readonly dropActive = signal(false);

  setDropActive(on: boolean): void {
    this.dropActive.set(on);
  }

  // --- Ouverture, transferts ---

  protected open(entry: FileEntry): void {
    if (entry.isDir) {
      void this.sftp.openDir(entry.name);
      return;
    }
    // L'aperçu lit par SFTP. En FTP, ouvrir son panneau donnait une surface
    // vide qui invitait justement à double-cliquer : on le dit une fois, dans
    // un toast à clé (il se remplace au lieu de s'empiler à chaque essai).
    if (this.sftp.protocol() !== 'sftp') {
      this.toasts.info(this.t('server.previewFtp'), {
        detail: this.t('server.previewFtpHint'),
        key: 'preview-ftp',
      });
      return;
    }
    // Rouvre le panneau Aperçu s'il était fermé (ou le focalise).
    this.dock.openPanel('preview');
    void this.preview.openFile(this.sftp.pathTo(entry.name), entry.name);
  }

  protected download(entry: FileEntry): void {
    void this.actions.download(this.session(), entry);
  }

  protected downloadSelection(): void {
    void this.actions.downloadSelection(this.session());
  }

  protected deleteSelection(): void {
    void this.actions.deleteSelection(
      this.sftp,
      this.sftp.protection() === 'confirm' ? this.sftp.host() : null,
    );
  }

  // --- Sélection multiple (idée 01) ---

  /**
   * Les lignes du listing, décorées une fois pour toutes : sélection, coupé,
   * colonne octale et infobulle se recalculent quand la LISTE ou la
   * SÉLECTION changent, plus jamais à chaque cycle de rendu (un glissé
   * réévaluait ~6 appels par ligne et par frame).
   */
  protected readonly serverRows = computed(() => {
    const cut = this.clipboard.cutNames();
    this.sftp.selection();
    return this.serverEntries().map((entry) => ({
      entry,
      selected: this.sftp.isSelected(entry.name),
      cut: cut.has(entry.name),
      mode: entry.mode === undefined ? '' : toOctal(entry.mode),
      modeTitle: this.modeTitle(entry),
    }));
  });

  private modeTitle(entry: FileEntry): string {
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
    // Mode « comparer » armé : ce clic DÉSIGNE le fichier, il ne sélectionne
    // pas. Les dossiers restent navigables pour aller chercher la cible.
    if (this.comparePick.armed() && !entry.isDir) {
      event.preventDefault();
      event.stopPropagation();
      this.comparePick.deliver({
        session: this.session(),
        path: this.sftp.pathTo(entry.name),
        name: entry.name,
      });
      return;
    }
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
      this.element.nativeElement
        .querySelector(`[data-entry="${CSS.escape(name)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  // --- Glissé pointeur (dans le panneau, vers l'autre panneau, entre fenêtres) ---

  protected readonly dropTargetDir = signal<string | null>(null);

  /** L'étiquette qui suit le curseur : sans elle, le geste ne se voit pas. */
  protected readonly dragLabel = signal<{ text: string; x: number; y: number } | null>(null);

  private dragged: FileEntry[] = [];
  private dragOrigin: { x: number; y: number; entry: FileEntry } | null = null;
  private dragging = false;
  /** Le hit-test du glissé est fait au rythme des frames, pas des events. */
  private moveRaf = 0;
  private lastMove: PointerEvent | null = null;

  /** Le glissé est sorti de la fenêtre : une autre est peut-être survolée. */
  private fedOutside = false;
  private lastDragFeed = 0;

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
    this.document.addEventListener('pointercancel', this.onPointerCancel, { once: true });
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
      // WebKit peut cesser de livrer les événements dès que le curseur sort
      // de la fenêtre, voire annuler le pointeur en route : la capture
      // garantit que moves, up et cancel continuent d'arriver, où que soit le
      // curseur. Posée au seuil seulement, pour ne pas retoucher les clics.
      try {
        this.document.body.setPointerCapture(event.pointerId);
      } catch {
        // Pointeur déjà éteint : le glissé restera local à la fenêtre.
      }
    }

    const what =
      this.dragged.length === 1 ? this.dragged[0].name : this.t('server.dragItems', { count: this.dragged.length });
    // Le geste dit ce qu'il fera : déplacer, ou copier si ⌥ est enfoncé.
    const label = event.altKey ? this.t('menu.copyWith', { what: ' ' + what }) : what;

    // Hors de la fenêtre, le glissé continue peut-être dans une autre : macOS
    // nous livre toujours les événements tant que le bouton est enfoncé, mais
    // la fenêtre d'en face ne voit rien. Le backend (seul à connaître la
    // géométrie des fenêtres à l'écran) relaie le survol à celle qui est
    // sous le curseur.
    if (this.isOutsideWindow(event)) {
      this.cancelMoveRaf();
      this.dragLabel.set(null);
      this.dropTargetDir.set(null);
      this.dragHint.clear();
      this.fedOutside = true;
      const now = Date.now();
      if (now - this.lastDragFeed >= DRAG_FEED_MS) {
        this.lastDragFeed = now;
        void invoke('drag_feed', {
          cx: event.clientX,
          cy: event.clientY,
          phase: 'move',
          text: label,
        }).catch(() => undefined);
      }
      return;
    }
    if (this.fedOutside) {
      // De retour chez nous : la fenêtre survolée éteint son accueil.
      this.fedOutside = false;
      void invoke('drag_feed', { cx: event.clientX, cy: event.clientY, phase: 'cancel' }).catch(
        () => undefined,
      );
    }
    this.lastMove = event;
    if (this.moveRaf === 0) {
      this.moveRaf = requestAnimationFrame(() => {
        this.moveRaf = 0;
        const move = this.lastMove;
        if (!move || !this.dragging) {
          return;
        }
        const count =
          this.dragged.length === 1 ? this.dragged[0].name : this.t('server.dragItems', { count: this.dragged.length });
        this.dragLabel.set({
          text: move.altKey ? this.t('menu.copyWith', { what: ' ' + count }) : count,
          x: move.clientX,
          y: move.clientY,
        });
        this.dropTargetDir.set(this.dirUnderPointer(move));
        // Au-dessus du panneau d'en face (vue côte à côte), c'est LUI qui
        // doit surligner sa ligne : l'indice partagé le lui dit.
        const overPane = this.paneSessionAt(move.clientX, move.clientY);
        this.dragHint.set(
          overPane && overPane !== this.session()
            ? { sessionId: overPane.id, dir: this.dirAt(move.clientX, move.clientY) }
            : null,
        );
      });
    }
  };

  private cancelMoveRaf(): void {
    if (this.moveRaf !== 0) {
      cancelAnimationFrame(this.moveRaf);
      this.moveRaf = 0;
    }
    this.lastMove = null;
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.document.removeEventListener('pointermove', this.onPointerMove);
    this.document.removeEventListener('pointercancel', this.onPointerCancel);
    this.cancelMoveRaf();
    this.document.body.classList.remove('is-dragging');
    this.releaseCapture(event);
    const entries = this.dragged;
    const wasDragging = this.dragging;
    const target = this.dropTargetDir();

    this.dragOrigin = null;
    this.dragging = false;
    this.dragged = [];
    this.dragLabel.set(null);
    this.dropTargetDir.set(null);
    this.dragHint.clear();

    if (!wasDragging || !entries.length) {
      return;
    }
    // Lâché hors de la fenêtre : le dépôt se joue dans celle d'en face. Le
    // backend la trouve et lui livre le lot ; c'est elle qui décide (conflits
    // compris) et qui montre l'avancement.
    if (this.isOutsideWindow(event)) {
      this.fedOutside = false;
      void invoke<string | null>('drag_feed', {
        cx: event.clientX,
        cy: event.clientY,
        phase: 'drop',
        payload: {
          connectionId: this.sftp.connectionId(),
          host: this.sftp.host(),
          fromDir: this.sftp.currentPath(),
          copy: event.altKey,
          entries: entries.map((entry) => ({ name: entry.name, isDir: entry.isDir })),
        },
      })
        .then((landed) => {
          if (landed) {
            this.sftp.clearSelection();
          }
        })
        .catch(() => undefined);
      return;
    }
    if (this.fedOutside) {
      this.fedOutside = false;
      void invoke('drag_feed', { cx: event.clientX, cy: event.clientY, phase: 'cancel' }).catch(
        () => undefined,
      );
    }

    // Le dépôt a-t-il atterri dans un AUTRE panneau serveur (vue double) ?
    // Même page, même geste : la cible se lit sous le curseur, et le collage
    // croisé fait le reste (même serveur : cp/mv ; différents : le pont).
    const paneSession = this.paneSessionAt(event.clientX, event.clientY);
    if (paneSession && paneSession !== this.session()) {
      const destination = this.dropPathIn(paneSession, event.clientX, event.clientY);
      void paneSession.clipboard
        .receiveDrop(
          {
            connectionId: this.sftp.connectionId() ?? '',
            host: this.sftp.host(),
            fromDir: this.sftp.currentPath(),
            copy: event.altKey,
            entries: entries.map((entry) => ({ name: entry.name, isDir: entry.isDir })),
          },
          destination,
        )
        .then(() => this.sftp.clearSelection());
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

  /**
   * Le système a repris le pointeur (sortie de fenêtre, geste) : tout
   * nettoyer. Sans ça, l'étiquette reste figée au bord de la fenêtre et le
   * `pointerup` en attente se rejouerait au clic suivant, déposant le lot
   * sur ce que le curseur survolerait alors.
   */
  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.document.removeEventListener('pointermove', this.onPointerMove);
    this.document.removeEventListener('pointerup', this.onPointerUp);
    this.cancelMoveRaf();
    this.document.body.classList.remove('is-dragging');
    this.releaseCapture(event);
    this.dragOrigin = null;
    this.dragging = false;
    this.dragged = [];
    this.dragLabel.set(null);
    this.dropTargetDir.set(null);
    this.dragHint.clear();
    if (this.fedOutside) {
      this.fedOutside = false;
      void invoke('drag_feed', { cx: event.clientX, cy: event.clientY, phase: 'cancel' }).catch(
        () => undefined,
      );
    }
  };

  private releaseCapture(event: PointerEvent): void {
    try {
      this.document.body.releasePointerCapture(event.pointerId);
    } catch {
      // Jamais capturé : rien à relâcher.
    }
  }

  /** La session du panneau serveur sous ce point, s'il y en a un. */
  private paneSessionAt(x: number, y: number): Session | null {
    const pane = this.document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>('[data-session-pane]');
    const id = pane?.dataset['sessionPane'];
    if (!id) {
      return null;
    }
    return this.registry.sessions().find((session) => session.id === id) ?? null;
  }

  /** La destination d'un dépôt dans un AUTRE panneau, à ce point. */
  private dropPathIn(target: Session, x: number, y: number): string {
    const crumb = this.document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-crumb]')
      ?.dataset['crumb'];
    if (crumb) {
      return crumb;
    }
    const dir = this.dirAt(x, y);
    return dir ? target.sftp.pathTo(dir) : target.sftp.currentPath();
  }

  /** Le dossier de la liste sous le curseur, s'il en accepte le dépôt. */
  private dirUnderPointer(event: PointerEvent): string | null {
    // La cible surlignée n'est que celle de CE panneau : un dépôt dans le
    // panneau d'en face est routé au lâcher, l'étiquette suit déjà le curseur.
    const row = this.element.nativeElement.contains(
      this.document.elementFromPoint(event.clientX, event.clientY) as Node | null,
    )
      ? this.dirAt(event.clientX, event.clientY)
      : null;
    // Un dossier qu'on traîne ne peut pas être sa propre destination.
    return row && !this.sftp.isSelected(row) ? row : null;
  }

  /** Cette ligne est-elle visée par un glissé venu d'un autre panneau ? */
  protected hintedDrop(entry: FileEntry): boolean {
    const hint = this.dragHint.hint();
    return !!hint && hint.sessionId === this.session().id && hint.dir === entry.name;
  }

  /** La ligne de dossier sous ce point, s'il y en a une. */
  private dirAt(x: number, y: number): string | null {
    const row = this.document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-entry]');
    const name = row?.dataset['entry'];
    return name && row?.dataset['dir'] === 'true' ? name : null;
  }

  /** Le curseur est-il sorti de la fenêtre ? (Coordonnées hors du viewport.) */
  private isOutsideWindow(event: PointerEvent): boolean {
    const view = this.document.defaultView;
    if (!view) {
      return false;
    }
    return (
      event.clientX < 0 ||
      event.clientY < 0 ||
      event.clientX >= view.innerWidth ||
      event.clientY >= view.innerHeight
    );
  }

  /** Le segment de fil d'Ariane sous le curseur, s'il y en a un. */
  private crumbUnderPointer(event: PointerEvent): string | null {
    const crumb = this.document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-crumb]');
    const path = crumb?.dataset['crumb'];
    return path && path !== this.sftp.currentPath() ? path : null;
  }

  // --- Le glissé venu d'une autre fenêtre (relayé par explorer-page) ---

  /** Survol : surligne la ligne visée, comme pour un glissé local. */
  foreignOver(x: number, y: number): void {
    this.dropTargetDir.set(this.dirAt(x, y));
  }

  foreignClear(): void {
    this.dropTargetDir.set(null);
  }

  /** La destination d'un dépôt étranger à ce point, dans CE panneau. */
  dropPathAt(x: number, y: number): string {
    return this.dropPathIn(this.session(), x, y);
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
      ? { label: this.t('menu.open'), icon: 'folder', action: () => void this.sftp.openDir(entry.name) }
      : { label: this.t('common.buttons.download'), icon: 'download', action: () => this.download(entry) };
    const items: ContextMenuItem[] = [first];
    if (entry.isDir) {
      items.push(...this.folderActions(this.sftp.pathTo(entry.name)));
    }
    if (!entry.isDir && this.sftp.protocol() === 'sftp') {
      items.push({
        label: this.t('server.preview'),
        icon: 'file',
        action: () => {
          this.dock.openPanel('preview');
          void this.preview.openFile(this.sftp.pathTo(entry.name), entry.name);
        },
      });
      if (this.sftp.protection() !== 'readonly') {
        items.push({
          label: this.t('server.editExternal'),
          icon: 'edit',
          action: () => void this.session().remoteEdit.start(this.sftp.pathTo(entry.name), entry.name),
        });
      }
      items.push({
        label: this.t('server.follow'),
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
        label: this.t('server.permissions'),
        icon: 'shield-check',
        action: () => this.session().permissions.open(entry, this.sftp.pathTo(entry.name)),
      });
    }
    items.push(
      { divider: true, label: '' },
      {
        label: this.t('menu.copyName'),
        icon: 'copy',
        action: () => this.actions.copyPath(entry.name),
      },
      {
        label: this.t('menu.copyPath'),
        icon: 'copy',
        action: () => this.actions.copyPath(this.sftp.pathTo(entry.name)),
      },
    );
    const writes = this.entryActions(entry);
    this.contextMenu.open(
      event,
      writes.length ? [...items, { divider: true, label: '' }, ...writes] : items,
    );
  }

  /**
   * L'action « coller », proposée partout où un clic droit peut tomber : sur
   * le fond, sur une ligne, sur une sélection. Le dossier de destination est
   * TOUJOURS le dossier courant : coller « dans » un fichier n'a pas de sens.
   */
  private pasteAction(): ContextMenuItem[] {
    if (!this.clipboard.hasContent() || this.sftp.protection() === 'readonly') {
      return [];
    }
    const count = this.clipboard.count();

    // Contenu venu du disque : coller ici, c'est ENVOYER. Ça marche donc aussi
    // en FTP, contrairement à la copie de serveur à serveur qui passe par le
    // canal exec.
    if (this.clipboard.fromDisk()) {
      return [
        {
          label: this.t('menu.sendHere', { count }),
          icon: 'upload',
          action: () => void this.uploadClipped(),
        },
      ];
    }
    if (this.sftp.protocol() !== 'sftp') {
      return [];
    }
    return [
      {
        label:
          this.clipboard.mode() === 'copy'
            ? this.t('menu.pasteHere', { count })
            : this.t('menu.moveHere', { count }),
        icon: 'clipboard',
        action: () => void this.clipboard.pasteHere(),
      },
    ];
  }

  /** Envoie ici ce que le presse-papiers tient du disque local. */
  private async uploadClipped(): Promise<void> {
    const clipped = this.clipboard.clipped();
    if (!clipped) {
      return;
    }
    const files = clipped.entries.filter((entry) => !entry.isDir);
    for (const entry of files) {
      const from = clipped.fromDir === '/' ? `/${entry.name}` : `${clipped.fromDir}/${entry.name}`;
      await this.actions.uploadWithGuard(
        this.session(),
        from,
        this.sftp.pathTo(entry.name),
        entry.name,
      );
    }
    await this.sftp.refresh();
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
        action: () => this.downloadSelection(),
      });
    }
    if (this.sftp.protocol() === 'sftp') {
      items.push(...this.clipboardActions(this.sftp.selectedEntries()), ...this.pasteAction());
    }
    items.push({
      label: this.t('menu.copyPaths'),
      icon: 'copy',
      action: () =>
        this.actions.copyPath(
          this.sftp
            .selectedEntries()
            .map((entry) => this.sftp.pathTo(entry.name))
            .join('\n'),
        ),
    });
    if (this.sftp.protection() !== 'readonly') {
      items.push({ divider: true, label: '' });
      if (this.session().trash.available()) {
        items.push({
          label: this.t('menu.trashCount', { count }),
          icon: 'trash',
          action: () => void this.actions.trashSelection(this.session(), this.sftp.selectedEntries()),
        });
      }
      items.push({
        label: this.t('menu.deleteCount', { count }),
        icon: 'trash',
        danger: true,
        action: () => this.deleteSelection(),
      });
    }
    this.contextMenu.open(event, items);
  }

  /** Ouvre le suivi de log dans le panneau Logs (rouvert au besoin). */
  private async followLog(entry: FileEntry): Promise<void> {
    this.dock.openPanel('logs');
    await this.session().logTail.open(this.sftp.pathTo(entry.name));
  }

  protected openServerAreaMenu(event: MouseEvent): void {
    const paste = this.pasteAction();
    this.contextMenu.open(event, [
      ...paste,
      ...(paste.length ? [{ divider: true, label: '' } as ContextMenuItem] : []),
      ...this.areaActions(),
      { divider: true, label: '' },
      ...this.folderActions(this.sftp.currentPath()),
      { divider: true, label: '' },
      {
        label: this.t('menu.copyCurrentPath'),
        icon: 'copy',
        action: () => this.actions.copyPath(this.sftp.currentPath()),
      },
    ]);
  }

  /**
   * Ce qu'on peut faire d'un dossier serveur sans y entrer : y ouvrir un
   * terminal, y chercher, en faire le point d'arrivée du profil.
   */
  private folderActions(path: string): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    // Le terminal n'existe qu'en SFTP (il vit sur la session SSH).
    if (this.sftp.protocol() === 'sftp') {
      items.push({
        label: this.t('server.openTerminalHere'),
        icon: 'terminal',
        action: () => {
          this.dock.openPanel('terminal');
          this.session().terminal.goTo(path);
        },
      });
    }

    items.push({
      label: this.t('server.searchHere'),
      icon: 'search',
      action: () => void this.palette.searchIn(path),
    });

    // Les favoris se rangent dans le profil : une connexion de passage n'a
    // nulle part où les écrire, l'entrée n'apparaît donc pas.
    const profile = this.sftp.profileId();
    if (profile) {
      const profileId = profile;
      const known = this.profiles.favoritesOf(profileId).some((item) => item.path === path);
      items.push(
        known
          ? {
              label: this.t('server.favoriteRemove'),
              icon: 'star',
              action: () => void this.profiles.removeFavorite(profileId, path),
            }
          : {
              label: this.t('server.favoriteAdd'),
              icon: 'star',
              action: () => {
                const label = path.split('/').filter(Boolean).pop() ?? '/';
                void this.profiles
                  .addFavorite(profileId, { path, label, icon: 'folder' })
                  .then((done) => {
                    if (done) {
                      this.dock.openPanel('favorites');
                    }
                  });
              },
            },
      );
    }

    items.push({
      label: this.t('server.searchDeep'),
      icon: 'search',
      action: () => {
        this.session().search.seed('', path);
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
          label: this.t('server.anchorSet'),
          icon: 'anchor',
          action: () => void this.profiles.setAnchor(profileId, path),
        });
      } else {
        items.push({
          label: this.t('server.anchorClear'),
          icon: 'anchor',
          action: () => void this.profiles.setAnchor(profileId, null),
        });
      }
    }

    return items;
  }

  /** Renommer / corbeille / suppression d'une entrée (écritures). */
  private entryActions(entry: FileEntry): ContextMenuItem[] {
    // Lecture seule : aucune action d'écriture.
    if (this.sftp.protection() === 'readonly') {
      return [];
    }
    const items: ContextMenuItem[] = [
      {
        label: this.t('menu.rename'),
        icon: 'pencil',
        action: () => void this.actions.renameEntry(this.sftp, entry),
      },
    ];
    // La corbeille passe devant : c'est le geste qu'on veut par défaut, celui
    // qui se rattrape. La suppression définitive reste juste en dessous.
    if (this.session().trash.available()) {
      items.push({
        label: this.t('menu.trash'),
        icon: 'trash',
        action: () => void this.actions.trashSelection(this.session(), [entry]),
      });
    }
    items.push({
      label: this.t('menu.deleteForever'),
      icon: 'trash',
      danger: true,
      action: () =>
        void this.actions.deleteEntry(
          this.sftp,
          entry,
          this.sftp.protection() === 'confirm' ? this.sftp.host() : null,
        ),
    });
    return items;
  }

  /** Nouveau dossier / fichier / actualiser, sur ce panneau. */
  private areaActions(): ContextMenuItem[] {
    const refresh: ContextMenuItem = {
      label: this.t('menu.refresh'),
      icon: 'refresh',
      action: () => void this.sftp.refresh(),
    };
    if (this.sftp.protection() === 'readonly') {
      return [refresh];
    }
    const items: ContextMenuItem[] = [
      {
        label: this.t('menu.newDir'),
        icon: 'folder-plus',
        action: () => void this.actions.createDirIn(this.sftp, this.t('menu.newDirServer')),
      },
    ];
    // La création de fichier passe par `sftp_create_file`, sans équivalent
    // FTP : le service la refusait déjà, mais le menu la proposait quand même.
    if (this.sftp.protocol() === 'sftp') {
      items.push({
        label: this.t('menu.newFile'),
        icon: 'file',
        action: () => void this.actions.createFileIn(this.sftp, this.t('menu.newFileServer')),
      });
    }
    items.push(refresh);
    return items;
  }
}
