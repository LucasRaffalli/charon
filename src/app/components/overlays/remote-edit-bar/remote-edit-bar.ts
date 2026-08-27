import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { RemoteEditService } from '@app/services/files/remote-edit.service';

/** Après ce délai sans activité, une ligne de la barre se masque (toast). */
const AUTO_HIDE_MS = 10_000;

/** Barre flottante listant les fichiers en édition distante (re-upload auto). */
@Component({
  selector: 'app-remote-edit-bar',
  imports: [DatePipe, Icon],
  templateUrl: './remote-edit-bar.html',
  styleUrl: './remote-edit-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteEditBar implements OnDestroy {
  protected readonly edit = inject(RemoteEditService);

  private readonly now = signal(Date.now());
  private readonly timer = setInterval(() => this.now.set(Date.now()), 1000);

  /** Les sessions visibles : erreurs toujours, sinon 10 s après la dernière activité. */
  protected readonly visible = computed(() => {
    const now = this.now();
    return this.edit
      .sessions()
      .filter((s) => s.status === 'error' || now - s.lastActivity < AUTO_HIDE_MS);
  });

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }
}
