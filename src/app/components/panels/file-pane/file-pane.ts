import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { SelectionBar } from '@app/components/panels/selection-bar/selection-bar';
import { Icon, IconName } from '@app/components/ui/icon/icon';
import { InputField } from '@app/components/ui/input/input';
import { injectT } from '@app/lang/i18n.service';
import { LocalTreeService } from '@app/services/connection/local-tree.service';
import { ServerTreeNode } from '@app/components/panels/server-tree/server-tree-node';
import { scopedKey } from '@app/services/system/window-scope';
import { FileEntry } from '@app/interfaces';

/**
 * Panneau de navigation compact dans un système de fichiers.
 * Purement présentationnel : l'état vient des inputs, les actions sortent en outputs.
 */
@Component({
  selector: 'app-file-pane',
  imports: [Icon, InputField, SelectionBar, ServerTreeNode],
  templateUrl: './file-pane.html',
  styleUrl: './file-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilePane {
  protected readonly t = injectT();

  readonly title = input.required<string>();
  readonly icon = input.required<IconName>();
  readonly path = input.required<string>();
  readonly entries = input.required<FileEntry[]>();
  readonly loading = input(false);
  readonly atRoot = input(false);
  readonly error = input<string | null>(null);
  /** N'affiche que les dossiers (navigation pure). */
  readonly dirsOnly = input(false, { transform: booleanAttribute });
  /**
   * Filtre du listing, relié au signal du navigateur parent : le filtrage
   * lui-même se fait dans le service, le panneau ne porte que le champ.
   */
  readonly filter = model('');
  /** Sans champ de filtre (navigation pure, listes courtes). */
  readonly filterable = input(true, { transform: booleanAttribute });
  /** Action proposée sur les fichiers (icône affichée au survol). */
  readonly actionIcon = input<IconName | null>(null);
  readonly actionLabel = input('');

  /**
   * Le dossier affiché peut être ancré comme dossier d'ouverture (issue #5).
   * Dans l'en-tête et pas seulement au clic droit : c'est une demande
   * d'accessibilité, un geste caché dans un menu contextuel se découvre mal.
   */
  readonly anchorable = input(false, { transform: booleanAttribute });
  readonly anchored = input(false);
  readonly anchorToggle = output<void>();

  /**
   * La vue arbre (issue #9, précisée par Lucas) : le panneau local peut se
   * regarder en liste plate ou en arborescence, la même que celle du serveur
   * (même moteur, même rendu). Un bouton d'en-tête bascule, et le choix est
   * retenu PAR FENÊTRE (`scopedKey`, comme la disposition du dock) : c'est de
   * la géographie d'écran, pas un réglage d'application.
   */
  readonly treeToggle = input(false, { transform: booleanAttribute });
  protected readonly viewMode = signal<'list' | 'tree'>(readStoredView());
  private readonly localTree = inject(LocalTreeService);
  protected readonly treeRoot = computed(() => this.localTree.root());

  protected toggleView(): void {
    const next = this.viewMode() === 'list' ? 'tree' : 'list';
    this.viewMode.set(next);
    try {
      localStorage.setItem(scopedKey(VIEW_KEY), next);
    } catch {
      // Un stockage indisponible ne casse pas la bascule, elle vaut pour la
      // session en cours.
    }
  }

  /**
   * Ce qui est sélectionné, tel que le navigateur le voit. Les entrées et non
   * les noms : le compte et la part de fichiers de la barre de sélection s'en
   * déduisent, sans que le panneau ait à recouper quoi que ce soit.
   */
  readonly selected = input<readonly FileEntry[]>([]);

  /** Les entrées coupées, en attente de collage : présentes mais déjà parties. */
  readonly cut = input<ReadonlySet<string>>(new Set<string>());

  /** Un clic sur une ligne, modificateurs compris (la sélection vit ailleurs). */
  readonly entryClick = output<{ event: MouseEvent; entry: FileEntry }>();
  /**
   * Double-clic ou Entrée : ouvrir un dossier. Sélectionner et ouvrir sont
   * deux gestes différents, ici comme dans le panneau serveur.
   */
  readonly openDir = output<FileEntry>();
  readonly navigateUp = output<void>();
  readonly fileAction = output<FileEntry>();
  /** Les flèches et Échap, quand le panneau a le focus. */
  readonly listKeydown = output<KeyboardEvent>();
  /** Un clic dans le vide de la liste. */
  readonly blankClick = output<void>();
  /** Clic droit sur une entrée. */
  readonly entryMenu = output<{ event: MouseEvent; entry: FileEntry }>();
  /** Clic droit sur le fond de la liste. */
  readonly areaMenu = output<MouseEvent>();

  // Les gestes du lot, portés par la barre de sélection.
  readonly selectionSend = output<void>();
  readonly selectionCopy = output<void>();
  readonly selectionRemove = output<void>();
  readonly selectionClear = output<void>();

  private readonly filterField = viewChild<InputField>('filterField');

  private readonly visibleEntries = computed(() =>
    this.dirsOnly() ? this.entries().filter((entry) => entry.isDir) : this.entries(),
  );

  private readonly selectedNames = computed(
    () => new Set(this.selected().map((entry) => entry.name)),
  );

  protected readonly rows = computed(() => {
    const picked = this.selectedNames();
    const cut = this.cut();
    return this.visibleEntries().map((entry) => ({
      entry,
      selected: picked.has(entry.name),
      cut: cut.has(entry.name),
    }));
  });

  /** Les dossiers ne s'envoient pas : la barre le dit. */
  protected readonly selectedFileCount = computed(
    () => this.selected().filter((entry) => !entry.isDir).length,
  );

  /** ⌘F sur ce panneau : la frappe part dans le champ de filtre. */
  focusFilter(): void {
    const field = this.filterField();
    field?.focus();
    field?.select();
  }

  protected open(entry: FileEntry): void {
    if (entry.isDir) {
      this.openDir.emit(entry);
    }
  }

  /**
   * Un clic dans le vide vide la sélection : c'est le geste de tous les
   * explorateurs, et sans lui il faut viser Échap.
   */
  protected onListClick(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('[data-entry]')) {
      this.blankClick.emit();
    }
  }
}

/** Clé du choix de vue du panneau local (liste ou arbre), par fenêtre. */
const VIEW_KEY = 'charon:local-view';

function readStoredView(): 'list' | 'tree' {
  try {
    return localStorage.getItem(scopedKey(VIEW_KEY)) === 'tree' ? 'tree' : 'list';
  } catch {
    return 'list';
  }
}
