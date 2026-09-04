import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { Modal } from '@app/components/ui/modal/modal';
import { TextField } from '@app/components/ui/text-field/text-field';
import { DialogService } from '@app/services/workspace/dialog.service';
import { injectT } from '@app/lang/i18n.service';

/** Rendu des dialogues confirm/prompt. À placer une seule fois, à la racine. */
@Component({
  selector: 'app-dialog-host',
  imports: [Button, Modal, TextField],
  templateUrl: './dialog-host.html',
  styleUrl: './dialog-host.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DialogHost {
  protected readonly t = injectT();
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
