import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { CharonGlyph } from '@app/components/brand/charon-logo/charon-glyph';
import { Button } from '@app/components/ui/button/button';
import { Icon } from '@app/components/ui/icon/icon';
import { UpdaterService } from '@app/services/updater.service';

/**
 * L'annonce d'une mise à jour prête : une carte qui monte du bas.
 *
 * Elle se range d'un clic sur la croix, et ne revient pas : c'est la pastille
 * de l'engrenage qui garde la trace, et les options avancées qui gardent le
 * bouton d'installation.
 */
@Component({
  selector: 'app-update-toast',
  imports: [Button, CharonGlyph, Icon],
  template: `
    @if (visible() && updater.updateAvailable() && !dismissed()) {
      <div class="toast" role="status">
        <span class="toast__tile"><app-charon-glyph /></span>
        <div class="toast__txt">
          <span class="toast__title">
            @if (availableVersion(); as v) {
              Charon {{ v }} est prête
            } @else {
              Une mise à jour est prête
            }
          </span>
          <span class="toast__sub">Installation signée, redémarre en quelques secondes</span>
        </div>
        <app-button type="button" (click)="updater.install()">Installer</app-button>
        <button
          type="button"
          class="toast__close"
          aria-label="Plus tard"
          (click)="dismissed.set(true)"
        >
          <app-icon name="close" [size]="13" />
        </button>
      </div>
    }
  `,
  styles: `
    /* L'hôte disparaît du flux : sinon il compte comme un enfant du
       conteneur centré et décale ce qui l'entoure. */
    :host {
      display: contents;
    }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      z-index: 6;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: 10px 11px 10px 16px;
      background: color-mix(in srgb, var(--elev-1) 96%, transparent);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-md);
      backdrop-filter: blur(16px);
      transform: translateX(-50%);
      animation: toast-rise 0.55s cubic-bezier(0.2, 1, 0.4, 1) 0.9s backwards;
    }

    /* Une mise à jour n'est pas une alerte, mais elle doit se remarquer. */
    .toast::before {
      content: '';
      position: absolute;
      left: 0;
      top: 11px;
      bottom: 11px;
      width: 3px;
      border-radius: 2px;
      background: var(--warning);
    }

    @keyframes toast-rise {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(18px);
      }
    }

    .toast__tile {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      flex-shrink: 0;
      background: var(--elev-2);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
    }

    .toast__tile app-charon-glyph {
      display: block;
      width: 21px;
    }

    .toast__txt {
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding-right: var(--space-2xs);
    }

    .toast__title {
      font-size: calc(12.5px * var(--text-scale));
      font-weight: 700;
    }

    .toast__sub {
      font-size: calc(10px * var(--text-scale));
      color: var(--text-muted);
    }

    .toast__close {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: none;
      border-radius: var(--radius-sm);
      background: none;
      color: var(--text-faint);
      cursor: pointer;
    }

    .toast__close:hover {
      background: var(--state-hover);
      color: var(--text-muted);
    }

    @media (prefers-reduced-motion: reduce) {
      .toast {
        animation: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpdateToast {
  /** L'écran est-il prêt à l'accueillir (fin de l'ouverture, par exemple). */
  readonly visible = input(true);

  protected readonly updater = inject(UpdaterService);
  protected readonly dismissed = signal(false);

  protected readonly availableVersion = computed(() => {
    const status = this.updater.status();
    return status.kind === 'available' ? status.version : null;
  });
}
