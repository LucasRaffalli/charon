import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { openUrl } from '@tauri-apps/plugin-opener';

import { Button } from '@app/components/ui/button/button';
import { Icon } from '@app/components/ui/icon/icon';
import { SegmentedControl, SegmentedOption } from '@app/components/ui/segmented-control/segmented-control';
import { PreviewService } from '@app/services/preview.service';

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
})
export class PreviewPanel {
  protected readonly preview = inject(PreviewService);
  protected readonly markdownViews = MARKDOWN_VIEWS;

  private readonly highlightEl = viewChild<ElementRef<HTMLElement>>('hl');

  /** Aligne le rendu colorisé (dessous) sur le scroll du textarea (dessus). */
  protected syncScroll(event: Event): void {
    const source = event.target as HTMLTextAreaElement;
    const hl = this.highlightEl()?.nativeElement;
    if (hl) {
      hl.scrollTop = source.scrollTop;
      hl.scrollLeft = source.scrollLeft;
    }
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
