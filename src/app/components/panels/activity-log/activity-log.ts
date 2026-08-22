import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';
import { ActivityKind } from '@app/interfaces';
import { ActivityLogService } from '@app/services/activity-log.service';

const KIND_ICONS: Record<ActivityKind, IconName> = {
  connect: 'server',
  disconnect: 'log-out',
  mkdir: 'folder-plus',
  rename: 'pencil',
  remove: 'trash',
  download: 'download',
  upload: 'upload',
  resume: 'refresh',
  cancel: 'close',
  edit: 'edit',
  error: 'alert-circle',
};

/** Contenu de l'onglet Journal du panneau inférieur. */
@Component({
  selector: 'app-activity-log',
  imports: [DatePipe, Icon],
  templateUrl: './activity-log.html',
  styleUrl: './activity-log.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityLog {
  protected readonly activity = inject(ActivityLogService);
  protected readonly copied = signal(false);

  protected iconFor(kind: ActivityKind): IconName {
    return KIND_ICONS[kind];
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.activity.asText());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // presse-papiers indisponible : rien à faire
    }
  }
}
