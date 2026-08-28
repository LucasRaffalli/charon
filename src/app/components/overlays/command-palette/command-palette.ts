import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { explainPattern } from '@app/services/workspace/regex-explain';
import { analysePattern } from '@app/services/workspace/regex-portability';
import {
  CATEGORY_LABELS,
  CommandPaletteService,
  MAX_FILTERS,
  PaletteCategory,
  PaletteCommand,
} from '@app/services/workspace/command-palette.service';

/** Un groupe de résultats : son compte réel, et les quelques lignes montrées. */
interface PaletteGroup {
  category: PaletteCategory;
  label: string;
  /** Précision sur le groupe : pour les fichiers, où l'on regarde. */
  detail: string;
  total: number;
  items: PaletteCommand[];
}

/**
 * Lignes montrées par groupe quand plusieurs catégories se partagent la place.
 * Dès qu'une seule répond, ou qu'on s'est restreint à elle, le plafond saute :
 * la liste défile, autant tout montrer.
 */
const PER_GROUP = 4;

/** Garde-fou de rendu : un dossier de mille entrées n'a pas à peupler le DOM. */
const HARD_CAP = 200;

/** Score de correspondance : préfixe > mot > inclusion > rien. */
const score = (command: PaletteCommand, query: string): number => {
  const haystack = `${command.label} ${command.detail ?? ''} ${command.keywords ?? ''}`.toLowerCase();
  const label = command.label.toLowerCase();
  if (label.startsWith(query)) {
    return 3;
  }
  if (haystack.split(/\s+/).some((word) => word.startsWith(query))) {
    return 2;
  }
  if (haystack.includes(query)) {
    return 1;
  }
  return 0;
};

@Component({
  selector: 'app-command-palette',
  imports: [Icon],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ⌘K est déclaré dans le registre des raccourcis (ShortcutsService) : un
  // écouteur ici en plus le ferait tirer deux fois, et il n'apparaîtrait pas
  // dans la liste ⌘/.
})
export class CommandPalette {
  protected readonly palette = inject(CommandPaletteService);

  /** La saisie vit dans le service : elle doit survivre à la fermeture. */
  protected readonly query = this.palette.query;
  protected readonly selected = signal(0);
  protected readonly maxFilters = MAX_FILTERS;

  /**
   * Les groupes dépliés à la demande. Voir plus est une affaire d'affichage,
   * pas de portée : ça ne doit pas poser de filtre, sinon on restreint la
   * recherche en croyant seulement dérouler une liste.
   */
  private readonly expanded = signal<ReadonlySet<PaletteCategory>>(new Set());

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');

  /**
   * Le motif compilé, ou l'erreur à afficher. En mode texte la saisie n'est
   * jamais compilée : une recherche courante ne doit pas obliger à échapper un
   * point, et un motif tapé au hasard ne doit pas devenir une regex coûteuse.
   */
  private readonly matcher = computed<{ test: (c: PaletteCommand) => boolean } | { error: string }>(
    () => {
      const raw = this.query().trim();
      const sensitive = this.palette.hasOption('casse');

      if (!this.palette.hasOption('regex')) {
        const needle = sensitive ? raw : raw.toLowerCase();
        return {
          test: (command) => {
            if (!needle) {
              return true;
            }
            const hay = `${command.label} ${command.detail ?? ''} ${command.keywords ?? ''}`;
            return (sensitive ? hay : hay.toLowerCase()).includes(needle);
          },
        };
      }

      const report = analysePattern(raw);
      if (!report.valid) {
        return { error: report.error ?? 'motif invalide' };
      }
      if (!raw) {
        return { test: () => true };
      }
      const pattern = new RegExp(raw, sensitive ? '' : 'i');
      return {
        test: (command) =>
          pattern.test(`${command.label} ${command.detail ?? ''} ${command.keywords ?? ''}`),
      };
    },
  );

  /**
   * Ce que le motif utilise et que la recherche sur le serveur ne comprendra
   * pas : `grep -E` parle POSIX étendu, pas le dialecte de JavaScript, de
   * Python ou de PCRE2. Mieux vaut le savoir avant de lancer que de s'étonner
   * des résultats ensuite.
   */
  protected readonly notPortable = computed(() => {
    if (!this.palette.hasOption('regex')) {
      return [];
    }
    return analysePattern(this.query().trim()).notPortable;
  });

  /**
   * La lecture du motif en français, avec la légende des symboles employés.
   *
   * Elle n'apparaît qu'en mode regex : en texte brut il n'y a rien à
   * expliquer, ce qu'on tape est ce qu'on cherche. Elle sert autant à
   * comprendre un motif juste qu'à réparer un motif cassé, d'où l'affichage
   * dans les deux cas.
   */
  protected readonly explanation = computed(() => {
    if (!this.palette.hasOption('regex')) {
      return null;
    }
    const raw = this.query().trim();
    if (!raw) {
      return null;
    }
    const report = explainPattern(raw);
    return report.error || report.plain ? report : null;
  });

  /** La ligne de pointage sous le motif fautif, alignée sur le caractère. */
  protected readonly caret = computed(() => {
    const index = this.explanation()?.error?.index ?? -1;
    return index >= 0 ? ' '.repeat(index) + '▲' : '';
  });

  /** Message d'erreur du motif, s'il y en a un. */
  protected readonly patternError = computed(() => {
    const matcher = this.matcher();
    return 'error' in matcher ? matcher.error : null;
  });

  /** Les résultats groupés par catégorie, chaque groupe plafonné. */
  protected readonly groups = computed<PaletteGroup[]>(() => {
    const matcher = this.matcher();
    if ('error' in matcher) {
      return [];
    }

    const raw = this.query().trim().toLowerCase();
    const goto = this.palette.gotoCommand(raw);
    if (goto) {
      return [
        { category: 'chemins', label: CATEGORY_LABELS.chemins, detail: '', total: 1, items: [goto] },
      ];
    }

    const scope = this.palette.scope();

    const kept = this.palette
      .commands()
      .filter((command) => (scope ? command.category === scope : true))
      .filter((command) => matcher.test(command));

    // Le classement ne vaut qu'en mode texte : une regex ne dit pas « mieux ».
    const ranked =
      raw && !this.palette.hasOption('regex')
        ? kept
            .map((command) => ({ command, rank: score(command, raw) }))
            .sort((a, b) => b.rank - a.rank)
            .map((entry) => entry.command)
        : kept;

    const filled = this.palette
      .categoryOrder()
      .map((category) => ({
        category,
        label: CATEGORY_LABELS[category],
        // Le groupe des fichiers dit où l'on regarde : sans ça, descendre dans
        // un dossier ne se voit nulle part.
        detail: category === 'fichiers' ? this.palette.browsePath() : '',
        items: ranked.filter((command) => command.category === category),
      }))
      .filter((group) => group.items.length > 0);

    // Rien ne justifie de tronquer une catégorie qui est seule à répondre, ni
    // une que l'on vient de déplier.
    const opened = this.expanded();
    const roomy = !!scope || filled.length <= 1;

    return filled.map((group) => ({
      category: group.category,
      label: group.label,
      detail: group.detail,
      total: group.items.length,
      items: group.items.slice(0, roomy || opened.has(group.category) ? HARD_CAP : PER_GROUP),
    }));
  });

  /** Les lignes sélectionnables, à plat : les titres de groupe n'en sont pas. */
  protected readonly flat = computed(() => this.groups().flatMap((group) => group.items));

  protected readonly total = computed(() =>
    this.groups().reduce((sum, group) => sum + group.total, 0),
  );

  constructor() {
    effect(() => {
      if (this.palette.open()) {
        this.selected.set(0);
        // La recherche précédente est gardée, mais sélectionnée : elle se voit,
        // et la première frappe l'écrase comme si le champ était vide.
        requestAnimationFrame(() => {
          const field = this.input()?.nativeElement;
          field?.focus();
          field?.select();
        });
      }
    });
    effect(() => {
      this.query();
      this.palette.filters();
      this.selected.set(0);
      // Une nouvelle recherche repart sur des groupes repliés.
      this.expanded.set(new Set());
    });
  }

  protected toggle(event: Event): void {
    event.preventDefault();
    this.palette.toggle();
  }

  /** La catégorie de la ligne sélectionnée, pour la touche de restriction. */
  private selectedCategory(): PaletteCategory | null {
    return this.flat()[this.selected()]?.category ?? null;
  }

  protected onKeydown(event: KeyboardEvent): void {
    const results = this.flat();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selected.update((index) => Math.min(index + 1, results.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selected.update((index) => Math.max(index - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        this.run(results[this.selected()], true);
        break;
      case 'Tab': {
        // Restreindre à la catégorie de la ligne courante : elle descend dans
        // le champ, et dès lors tout se cherche dedans et rien en dehors.
        const category = this.selectedCategory();
        if (category && !this.palette.scope()) {
          event.preventDefault();
          // La saisie reste : c'est le terme cherché, restreindre ne fait que
          // dire où le chercher.
          this.palette.restrictTo(category);
        }
        break;
      }
      case 'Backspace':
        // Sur une saisie vide, le retour arrière mord sur les filtres.
        if (!this.query() && this.palette.filters().length) {
          event.preventDefault();
          this.palette.removeLastFilter();
        }
        break;
      case 'Escape':
        event.preventDefault();
        this.palette.close();
        break;
    }
  }

  /** Dérouler un groupe : rien d'autre ne bouge, surtout pas la portée. */
  protected expand(category: PaletteCategory): void {
    this.expanded.update((set) => new Set(set).add(category));
    this.input()?.nativeElement.focus();
  }

  protected restrict(category: PaletteCategory): void {
    this.palette.restrictTo(category);
    this.input()?.nativeElement.focus();
  }

  protected indexOf(command: PaletteCommand): number {
    return this.flat().indexOf(command);
  }

  protected run(command: PaletteCommand | undefined, byKeyboard = false): void {
    if (!command) {
      return;
    }
    // Entrée engage : là où le clic se contente de regarder, elle emmène.
    if (byKeyboard && command.commit) {
      this.palette.close();
      void command.commit();
      return;
    }
    // Ce qui se poursuit garde la palette ouverte : entrer dans un dossier,
    // poser un filtre. Sinon descendre de trois dossiers demanderait de la
    // rouvrir trois fois.
    if (command.keepOpen) {
      void command.run();
      this.palette.setQuery('');
      this.input()?.nativeElement.focus();
      return;
    }
    this.palette.close();
    void command.run();
  }
}
