import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Button } from '@app/components/button/button';
import { Icon } from '@app/components/icon/icon';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { DiffLine, diffStats, toSplitRows } from '@app/services/diff';
import { OverwriteService } from '@app/services/overwrite.service';

type DiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; lines: DiffLine[] }
  | { kind: 'unavailable' };

type DiffView = 'split' | 'unified';

@Component({
  selector: 'app-overwrite-dialog',
  imports: [Button, Icon, DatePipe, FileSizePipe],
  templateUrl: './overwrite-dialog.html',
  styleUrl: './overwrite-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverwriteDialog {
  protected readonly overwrite = inject(OverwriteService);
  protected readonly diff = signal<DiffState>({ kind: 'idle' });
  protected readonly view = signal<DiffView>('split');

  /** Lignes du diff quand il est prêt, null sinon. */
  private readonly readyLines = computed(() => {
    const state = this.diff();
    return state.kind === 'ready' ? state.lines : null;
  });

  protected readonly unifiedLines = computed(() => this.readyLines() ?? []);
  protected readonly splitRows = computed(() => {
    const lines = this.readyLines();
    return lines ? toSplitRows(lines) : [];
  });
  protected readonly stats = computed(() => {
    const lines = this.readyLines();
    return lines ? diffStats(lines) : { added: 0, removed: 0 };
  });

  /** Date epoch-secondes → millisecondes pour le pipe date (0 = inconnu). */
  protected ms(seconds: number): number | null {
    return seconds > 0 ? seconds * 1000 : null;
  }

  protected async showDiff(): Promise<void> {
    const request = this.overwrite.state();
    if (!request) {
      return;
    }
    this.diff.set({ kind: 'loading' });
    const lines = await request.loadDiff();
    this.diff.set(lines ? { kind: 'ready', lines } : { kind: 'unavailable' });
  }

  protected confirm(): void {
    this.reset();
    this.overwrite.settle('overwrite');
  }

  protected cancel(): void {
    this.reset();
    this.overwrite.settle('cancel');
  }

  private reset(): void {
    this.diff.set({ kind: 'idle' });
    this.view.set('split');
  }
}
