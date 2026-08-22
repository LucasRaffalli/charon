import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';

export type AlertVariant = 'error' | 'info';

@Component({
  selector: 'app-alert',
  imports: [Icon],
  templateUrl: './alert.html',
  styleUrl: './alert.scss',
  host: {
    // Annoncé par les lecteurs d'écran : les erreurs interrompent, l'info non.
    '[attr.role]': "variant() === 'error' ? 'alert' : 'status'",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Alert {
  readonly variant = input<AlertVariant>('info');
}
