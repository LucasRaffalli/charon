import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';

import { Button } from '@app/components/button/button';
import { TextField } from '@app/components/text-field/text-field';
import { DialogService } from '@app/services/dialog.service';

/** Rendu des dialogues confirm/prompt. À placer une seule fois, à la racine. */
@Component({
  selector: 'app-dialog-host',
  imports: [Button, TextField],
  templateUrl: './dialog-host.html',
  styleUrl: './dialog-host.scss',
  host: {
    '(document:keydown.escape)': 'cancel()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DialogHost {
  protected readonly dialog = inject(DialogService);
  protected readonly input = signal('');

  constructor() {
    effect(() => {
      const state = this.dialog.state();
      if (state?.kind === 'prompt') {
        this.input.set(state.value ?? '');
      }
    });
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    const state = this.dialog.state();
    if (!state) {
      return;
    }
    if (state.kind === 'confirm') {
      this.dialog.settle(true);
    } else if (this.input().trim() !== '') {
      this.dialog.settle(this.input().trim());
    }
  }

  protected cancel(): void {
    if (this.dialog.state()) {
      this.dialog.settle(null);
    }
  }
}
