import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';

/**
 * Une erreur annoncée en carte flottante plutôt qu'en ligne : le contenu
 * derrière garde sa taille, et un échec se remarque mieux qu'un texte glissé
 * entre deux champs.
 *
 * Elle se place au-dessus de l'annonce de mise à jour quand les deux tombent
 * en même temps : un échec prime, et la mise à jour reste accessible ailleurs.
 */
@Component({
  selector: 'app-error-toast',
  imports: [Icon],
  template: `
    @if (message()) {
      <div class="err" role="alert">
        <app-icon class="err__icon" name="alert-circle" [size]="16" />
        <span class="err__msg">{{ message() }}</span>
        <button type="button" class="err__close" aria-label="Fermer" (click)="dismiss.emit()">
          <app-icon name="close" [size]="13" />
        </button>
      </div>
    }
  `,
  styles: `
    /* L'hôte disparaît du flux : la carte se place par rapport à la fenêtre. */
    :host {
      display: contents;
    }

    .err {
      position: fixed;
      left: 50%;
      bottom: 24px;
      z-index: 7;
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      max-width: min(460px, calc(100vw - 48px));
      padding: 10px 10px 10px 14px;
      background: color-mix(in srgb, var(--elev-1) 96%, transparent);
      border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-md);
      backdrop-filter: blur(16px);
      transform: translateX(-50%);
      animation: err-rise 0.4s cubic-bezier(0.2, 1, 0.4, 1);
    }

    .err::before {
      content: '';
      position: absolute;
      left: 0;
      top: 10px;
      bottom: 10px;
      width: 3px;
      border-radius: 2px;
      background: var(--danger);
    }

    @keyframes err-rise {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(14px);
      }
    }

    .err__icon {
      flex-shrink: 0;
      color: var(--danger);
    }

    .err__msg {
      flex: 1;
      min-width: 0;
      font-size: calc(12px * var(--text-scale));
      line-height: 1.45;
      word-break: break-word;
    }

    .err__close {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      padding: 0;
      border: none;
      border-radius: var(--radius-sm);
      background: none;
      color: var(--text-faint);
      cursor: pointer;
    }

    .err__close:hover {
      background: var(--state-hover);
      color: var(--text);
    }

    @media (prefers-reduced-motion: reduce) {
      .err {
        animation: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorToast {
  /** Vide ou nul : rien ne s'affiche. */
  readonly message = input<string | null>(null);
  readonly dismiss = output<void>();
}
