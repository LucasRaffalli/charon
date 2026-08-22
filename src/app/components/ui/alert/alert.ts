import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Icon } from '@app/components/icon/icon';

export type AlertVariant = 'error' | 'info';

@Component({
  selector: 'app-alert',
  imports: [Icon],
  templateUrl: './alert.html',
  styleUrl: './alert.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Alert {
  readonly variant = input<AlertVariant>('info');
}
