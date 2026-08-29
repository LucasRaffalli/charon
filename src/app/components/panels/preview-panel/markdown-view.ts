import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Le rendu markdown de l'aperçu, extrait du panneau (budget CSS) : le HTML
 * vient de `renderMarkdown` via [innerHTML], ses styles vivent ici.
 */
@Component({
  selector: 'app-markdown-view',
  template: `<div class="rendered" [innerHTML]="html()" (click)="onClick($event)"></div>`,
  styleUrl: './markdown-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkdownView {
  readonly html = input.required<string>();

  /**
   * Un lien suivi dans le rendu ferait naviguer la WebView entière hors de
   * l'application : la navigation est toujours annulée, et les URL externes
   * partent vers le navigateur du système.
   */
  protected onClick(event: MouseEvent): void {
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
