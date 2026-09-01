import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { formatClock } from '@app/services/system/date-format';
import { RemoteEditService } from '@app/services/files/remote-edit.service';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { injectT } from '@app/lang/i18n.service';

/** Après ce délai sans activité, une ligne de la barre se masque (toast). */
const AUTO_HIDE_MS = 10_000;

/** Barre flottante listant les fichiers en édition distante (re-upload auto). */
@Component({
  selector: 'app-remote-edit-bar',
  imports: [Icon],
  templateUrl: './remote-edit-bar.html',
  styleUrl: './remote-edit-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteEditBar {
  protected readonly t = injectT();
  private readonly sessionRegistry = inject(SessionRegistry);

  protected get edit(): RemoteEditService {
    return this.sessionRegistry.focused().remoteEdit;
  }

  private readonly now = signal(Date.now());
  protected readonly clock = formatClock;

  constructor() {
    // Le tic d'une seconde ne tourne que s'il y a une édition à masquer :
    // un setInterval permanent réveillait l'app chaque seconde à vie, même
    // sans aucune édition distante (et App Nap ne s'endormait jamais).
    effect((onCleanup) => {
      if (this.edit.sessions().length === 0) {
        return;
      }
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  /** Les sessions visibles : erreurs toujours, sinon 10 s après la dernière activité. */
  protected readonly visible = computed(() => {
    const now = this.now();
    return this.edit
      .sessions()
      .filter((s) => s.status === 'error' || now - s.lastActivity < AUTO_HIDE_MS);
  });

}
