import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { openUrl } from '@tauri-apps/plugin-opener';

import { Button } from '@app/components/ui/button/button';
import { Icon } from '@app/components/ui/icon/icon';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { PreviewService } from '@app/services/files/preview.service';
import { DockService } from '@app/services/workspace/dock.service';

const MARKDOWN_VIEWS: readonly SegmentedOption[] = [
  { value: 'rendered', label: 'Aperçu' },
  { value: 'source', label: 'Source' },
];

/** Panneau de droite : aperçu/édition du fichier serveur ouvert. */
@Component({
  selector: 'app-preview-panel',
  imports: [Button, Icon, SegmentedControl],
  templateUrl: './preview-panel.html',
  styleUrl: './preview-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ⌘F est routé par ExplorerPage : dans l'aperçu il cherche dans le fichier,
  // ailleurs il filtre le dossier. Deux écouteurs pour la même touche
  // tireraient tous les deux.
})
export class PreviewPanel {
  protected readonly preview = inject(PreviewService);
  private readonly dock = inject(DockService);
  protected readonly markdownViews = MARKDOWN_VIEWS;

  private readonly highlightEl = viewChild<ElementRef<HTMLElement>>('hl');
  private readonly occEl = viewChild<ElementRef<HTMLElement>>('occ');
  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private readonly findField = viewChild<ElementRef<HTMLInputElement>>('findField');

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

  /** Aligne les couches du dessous (occurrences, coloration) sur le textarea. */
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

  /**
   * Un lien suivi dans le rendu markdown ferait naviguer la WebView entière
   * hors de l'application : la navigation est toujours annulée, et les URL
   * externes partent vers le navigateur du système.
   */
  protected onRenderedClick(event: MouseEvent): void {
    const link = (event.target as HTMLElement).closest('a');
    if (!link) {
      return;
    }
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      void openUrl(href).catch(() => undefined);
    }
  }
}
