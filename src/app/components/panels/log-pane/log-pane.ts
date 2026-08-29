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
import { LogTailService } from '@app/services/files/log-tail.service';
import { SessionRegistry } from '@app/services/connection/session-registry';

/** Contenu de l'onglet Logs : suivi de fichier en direct avec filtre. */
@Component({
  selector: 'app-log-pane',
  imports: [Icon],
  templateUrl: './log-pane.html',
  styleUrl: './log-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LogPane {
  private readonly sessionRegistry = inject(SessionRegistry);

  protected get tail(): LogTailService {
    return this.sessionRegistry.focused().logTail;
  }

  protected readonly filter = signal('');
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** Collé en bas = on suit le flux ; remonté = on fige la vue. */
  private stickToBottom = true;

  protected readonly visibleLines = computed(() => {
    const query = this.filter().trim().toLowerCase();
    const lines = this.tail.lines();
    return query ? lines.filter((line) => line.text.toLowerCase().includes(query)) : lines;
  });

  constructor() {
    effect(() => {
      this.visibleLines();
      if (this.stickToBottom) {
        requestAnimationFrame(() => {
          const element = this.scroller()?.nativeElement;
          element?.scrollTo({ top: element.scrollHeight });
        });
      }
    });
  }

  protected onScroll(): void {
    const element = this.scroller()?.nativeElement;
    if (!element) {
      return;
    }
    this.stickToBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }
}
