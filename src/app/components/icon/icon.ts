import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  Anchor,
  ArrowDownUp,
  ArrowUp,
  Check,
  ChevronRight,
  CircleAlert,
  Contrast,
  Download,
  File,
  Folder,
  Info,
  KeyRound,
  LUCIDE_ICONS,
  LayoutGrid,
  LogOut,
  FolderPlus,
  LucideAngularModule,
  LucideIconProvider,
  Monitor,
  Moon,
  Palette,
  Pencil,
  RefreshCw,
  Rows3,
  Sparkles,
  Server,
  Settings,
  SquarePen,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-angular';

// Registre des icônes Lucide utilisées par l'application.
const ICONS = {
  anchor: Anchor,
  folder: Folder,
  file: File,
  'arrow-up': ArrowUp,
  'arrow-down-up': ArrowDownUp,
  check: Check,
  'chevron-right': ChevronRight,
  'log-out': LogOut,
  sun: Sun,
  moon: Moon,
  contrast: Contrast,
  'alert-circle': CircleAlert,
  info: Info,
  key: KeyRound,
  monitor: Monitor,
  server: Server,
  download: Download,
  upload: Upload,
  settings: Settings,
  close: X,
  trash: Trash2,
  pencil: Pencil,
  'folder-plus': FolderPlus,
  refresh: RefreshCw,
  sparkles: Sparkles,
  palette: Palette,
  edit: SquarePen,
  'layout-grid': LayoutGrid,
  rows: Rows3,
} as const;

export type IconName = keyof typeof ICONS;

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
  readonly name = input.required<IconName>();
  readonly size = input(20);

  protected readonly icon = computed(() => ICONS[this.name()]);
}
