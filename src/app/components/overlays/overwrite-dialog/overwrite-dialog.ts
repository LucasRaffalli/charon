import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { formatStamp } from '@app/services/system/date-format';
import { Button } from '@app/components/ui/button/button';
import { Icon } from '@app/components/ui/icon/icon';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { DiffLine, diffStats, toSplitRows } from '@app/services/files/diff';
import { OverwriteRequest, OverwriteSides, UPLOAD_SIDES, OverwriteService } from '@app/services/files/overwrite.service';
import { injectT } from '@app/lang/i18n.service';

type DiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; lines: DiffLine[] }
  | { kind: 'unavailable' };

type DiffView = 'split' | 'unified';

@Component({
  selector: 'app-overwrite-dialog',
  imports: [Button, Icon, FileSizePipe],
  templateUrl: './overwrite-dialog.html',
  styleUrl: './overwrite-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverwriteDialog {
  protected readonly stamp = formatStamp;
  /** Les libellés des deux côtés : envoi par défaut, collage si précisé. */
  protected sides(request: OverwriteRequest): OverwriteSides {
    return request.sides ?? UPLOAD_SIDES;
  }

  protected readonly t = injectT();
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

  /** Décisions autres que les deux boutons principaux. */
  protected all(decision: 'overwrite-all' | 'skip-all' | 'keep-both'): void {
    this.reset();
    this.overwrite.settle(decision);
  }

  private reset(): void {
    this.diff.set({ kind: 'idle' });
    this.view.set('split');
  }
}
