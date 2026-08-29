import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';
import { ActivityKind } from '@app/interfaces';
import { Session, SessionRegistry } from '@app/services/connection/session-registry';
import { formatClock } from '@app/services/system/date-format';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { TabBarService } from '@app/services/workspace/tab-bar.service';

const KIND_ICONS: Record<ActivityKind, IconName> = {
  connect: 'server',
  module: 'layout-grid',
  disconnect: 'log-out',
  mkdir: 'folder-plus',
  rename: 'pencil',
  remove: 'trash',
  download: 'download',
  upload: 'upload',
  resume: 'refresh',
  cancel: 'close',
  edit: 'edit',
  anchor: 'anchor',
  error: 'alert-circle',
};

/** Contenu de l'onglet Journal du panneau inférieur. */
@Component({
  selector: 'app-activity-log',
  imports: [Icon],
  templateUrl: './activity-log.html',
  styleUrl: './activity-log.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityLog {
  protected readonly activity = inject(ActivityLogService);
  private readonly sessionRegistry = inject(SessionRegistry);
  private readonly tabBar = inject(TabBarService);
  protected readonly copied = signal(false);
  protected readonly clock = formatClock;

  /** À une seule session, la vignette n'apporterait rien : tout vient d'elle. */
  protected readonly multiSession = computed(() => this.sessionRegistry.sessions().length > 1);

  protected iconFor(kind: ActivityKind): IconName {
    return KIND_ICONS[kind];
  }

  /** La session d'une entrée, si elle vit encore (le journal lui survit). */
  protected sessionOf(id: string | null | undefined): Session | null {
    if (!id) {
      return null;
    }
    return this.sessionRegistry.sessions().find((session) => session.id === id) ?? null;
  }

  protected sessionTitle(session: Session): string {
    return this.tabBar.titleOf(session);
  }

  protected sessionToneBg(session: Session): string {
    return `var(--session-${this.sessionRegistry.toneOf(session)})`;
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
