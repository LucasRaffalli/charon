import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { SessionRecapService } from '@app/services/workspace/session-recap.service';

/**
 * Le bilan de session (idée 06) : ce qu'on laisse derrière soi au moment de
 * débarquer, une ligne par nature avec sa pastille et son chemin.
 *
 * Une carte plutôt qu'une phrase dans un dialogue de confirmation : « 2
 * fichiers envoyés dans /var/www » se lit d'un coup d'œil en colonnes, pas en
 * énumération.
 */
@Component({
  selector: 'app-session-recap',
  imports: [Button],
  template: `
    @if (recap.state(); as request) {
      <div class="scrim" (click)="recap.settle(false)">
        <div
          class="recap"
          role="dialog"
          aria-modal="true"
          aria-label="Bilan de session"
          (click)="$event.stopPropagation()"
          (keydown.escape)="recap.settle(false)"
        >
          <div>
            <div class="recap__title">Débarquer de {{ request.host }} ?</div>
            <div class="recap__host">
              {{ request.address }}@if (request.prod) { · <b>PROD</b> }
            </div>
          </div>

          <div class="recap__list">
            @for (line of request.lines; track line.text) {
              <span class="recap__line">
                <span class="recap__dot recap__dot--{{ line.tone }}"></span>
                {{ line.text }}
                <span class="recap__path">{{ line.where }}</span>
              </span>
            }
          </div>

          <div class="recap__actions">
            <app-button variant="ghost" (click)="recap.settle(false)">Rester</app-button>
            <app-button variant="danger" (click)="recap.settle(true)">Débarquer</app-button>
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './session-recap.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionRecap {
  protected readonly recap = inject(SessionRecapService);
}
