import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import {
  Anchor,
  ArrowDownUp,
  ArrowUp,
  Check,
  Clipboard,
  Command,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Contrast,
  Copy,
  CornerLeftUp,
  Download,
  File,
  FileBraces,
  FileCode,
  FileCog,
  FileDiff,
  FileTerminal,
  FileText,
  Funnel,
  Scissors,
  Folder,
  Image,
  GripVertical,
  Info,
  KeyRound,
  LUCIDE_ICONS,
  LayoutGrid,
  Lock,
  LogOut,
  FolderPlus,
  Columns2,
  Save,
  Plus,
  LucideAngularModule,
  LucideIconProvider,
  Monitor,
  Moon,
  Palette,
  Pencil,
  RefreshCw,
  ListTree,
  Rows3,
  ScrollText,
  Search,
  Sparkles,
  Star,
  SquareTerminal,
  Server,
  Settings,
  ShieldCheck,
  SquarePen,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-angular';

// Registre des icônes Lucide utilisées par l'application.
const ICONS = {
  anchor: Anchor,
  star: Star,
  folder: Folder,
  file: File,
  // Icônes par type de fichier (voir `services/file-icon.ts`).
  'file-code': FileCode,
  'file-json': FileBraces,
  'file-text': FileText,
  'file-shell': FileTerminal,
  'file-config': FileCog,
  'file-diff': FileDiff,
  'file-image': Image,
  'arrow-up': ArrowUp,
  'arrow-down-up': ArrowDownUp,
  'corner-up': CornerLeftUp,
  grip: GripVertical,
  check: Check,
  'chevron-down': ChevronDown,
  clipboard: Clipboard,
  command: Command,
  funnel: Funnel,
  scissors: Scissors,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'log-out': LogOut,
  sun: Sun,
  moon: Moon,
  contrast: Contrast,
  copy: Copy,
  'alert-circle': CircleAlert,
  info: Info,
  key: KeyRound,
  monitor: Monitor,
  server: Server,
  logs: ScrollText,
  search: Search,
  terminal: SquareTerminal,
  download: Download,
  upload: Upload,
  settings: Settings,
  close: X,
  trash: Trash2,
  pencil: Pencil,
  'folder-plus': FolderPlus,
  plus: Plus,
  columns: Columns2,
  save: Save,
  refresh: RefreshCw,
  sparkles: Sparkles,
  palette: Palette,
  edit: SquarePen,
  'layout-grid': LayoutGrid,
  lock: Lock,
  'shield-check': ShieldCheck,
  'list-tree': ListTree,
  rows: Rows3,
} as const;

export type IconName = keyof typeof ICONS;

// ---------------------------------------------------------------------------
// Le catalogue complet, chargé à la demande (issue #10).
//
// Le registre ci-dessus reste la seule source du bundle initial : ~70 icônes
// choisies une à une. Le reste de lucide (1700 icônes, 2,5 Mo) vit dans un
// chunk paresseux que la recherche d'icônes des favoris charge à la première
// saisie — le patron Prettier/Prism. Un favori qui porte une icône hors
// registre déclenche aussi le chargement : l'icône apparaît dès que le chunk
// arrive, un dossier générique tient la place d'ici là.

type IconData = (typeof ICONS)[IconName];

const EXTRA = new Map<string, IconData>();
/** Version du catalogue étendu : les `computed` qui lisent EXTRA s'y accrochent. */
const extraVersion = signal(0);
let catalogLoading: Promise<void> | null = null;

/** PascalCase de lucide vers le kebab-case des noms d'icônes (`FileText` → `file-text`). */
function kebabOf(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase();
}

/** Charge le catalogue complet ; idempotent, jamais au démarrage. */
export function ensureIconCatalog(): Promise<void> {
  catalogLoading ??= import('lucide-angular/src/icons').then((module) => {
    for (const [pascal, data] of Object.entries(module as unknown as Record<string, IconData>)) {
      // Les alias `XxxIcon` doublent chaque icône : une seule entrée suffit.
      if (pascal.endsWith('Icon') || typeof data === 'function' || !Array.isArray(data)) {
        continue;
      }
      const name = kebabOf(pascal);
      if (!(name in ICONS)) {
        EXTRA.set(name, data);
      }
    }
    extraVersion.update((version) => version + 1);
  });
  return catalogLoading;
}

/** Les noms du catalogue étendu (vide tant qu'il n'est pas chargé). */
export function catalogNames(): string[] {
  extraVersion();
  return [...Object.keys(ICONS), ...EXTRA.keys()];
}

@Component({
  selector: 'app-icon',
  imports: [LucideAngularModule],
  providers: [{ provide: LUCIDE_ICONS, multi: true, useValue: new LucideIconProvider(ICONS) }],
  template: `<lucide-icon [img]="icon()" [size]="size()" [strokeWidth]="2" />`,
  styles: `
    :host {
      display: inline-flex;
      line-height: 0;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Icon {
  // `string & {}` : les noms du registre gardent l'autocomplétion, et un nom
  // du catalogue étendu (favori à icône libre) passe sans forcer le type.
  readonly name = input.required<IconName | (string & {})>();
  readonly size = input(20);

  protected readonly icon = computed(() => {
    extraVersion();
    const name = this.name();
    const known = ICONS[name as IconName] ?? EXTRA.get(name);
    if (known) {
      return known;
    }
    // Icône hors registre et catalogue pas encore là : on le demande, le
    // dossier générique tient la place, et la version fera re-calculer.
    void ensureIconCatalog();
    return ICONS.folder;
  });
}
