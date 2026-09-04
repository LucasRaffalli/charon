import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { Modal } from '@app/components/ui/modal/modal';
import { TextField } from '@app/components/ui/text-field/text-field';
import { Toggle } from '@app/components/ui/toggle/toggle';
import { DialogService } from '@app/services/workspace/dialog.service';
import { injectT } from '@app/lang/i18n.service';

/** Rendu des dialogues confirm/prompt. À placer une seule fois, à la racine. */
@Component({
  selector: 'app-dialog-host',
  imports: [Button, Modal, TextField, Toggle],
  templateUrl: './dialog-host.html',
  styleUrl: './dialog-host.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DialogHost {
  protected readonly t = injectT();
  protected readonly dialog = inject(DialogService);
  protected readonly input = signal('');
  /** Coché avant de pouvoir confirmer, quand `acknowledge` est posé. */
  protected readonly acknowledged = signal(false);

  constructor() {
    effect(() => {
      const state = this.dialog.state();
      if (state?.kind === 'prompt') {
        this.input.set(state.value ?? '');
      }
      // Une case décochée ne doit jamais survivre à la boîte suivante.
      this.acknowledged.set(false);
    });
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    const state = this.dialog.state();
    if (!state || (state.acknowledge && !this.acknowledged())) {
      return;
    }
    if (state.kind === 'confirm') {
      this.dialog.settle(true);
    } else if (this.input().trim() !== '') {
      this.dialog.settle(this.input().trim());
    }
  }

  /** Le bouton de confirmation est-il actionnable ? */
  protected readonly canSubmit = computed(() => {
    const state = this.dialog.state();
    return !state?.acknowledge || this.acknowledged();
  });

  protected cancel(): void {
    if (this.dialog.state()) {
      this.dialog.settle(null);
    }
  }
}
