import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Les lueurs de fond de l'écran de connexion : trois foyers flous qui dérivent
 * lentement, teintés par l'accent courant.
 *
 * Ce sont les seules formes vraiment rondes de l'app : la règle « jamais de
 * plein arrondi » vise les composants, pas une tache de lumière.
 */
@Component({
  selector: 'app-aurora-sky',
  template: '<i></i><i></i><i></i>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class.aurora--lit]': 'lit()',
  },
  styles: `
    :host {
      position: absolute;
      inset: 0;
      overflow: hidden;
      opacity: 0;
      transition: opacity 1.6s ease 0.2s;
      pointer-events: none;
    }

    :host(.aurora--lit) {
      opacity: 1;
    }

    i {
      position: absolute;
      border-radius: 50%;
      filter: blur(52px);
      mix-blend-mode: screen;
    }

    i:nth-child(1) {
      width: 58vmax;
      height: 44vmax;
      left: -12vmax;
      top: -10vmax;
      background: radial-gradient(
        circle,
        color-mix(in srgb, var(--accent-solid) 45%, transparent),
        transparent 65%
      );
      animation: drift-a 19s ease-in-out infinite alternate;
    }

    i:nth-child(2) {
      width: 52vmax;
      height: 40vmax;
      right: -14vmax;
      bottom: -16vmax;
      background: radial-gradient(
        circle,
        color-mix(in srgb, var(--accent) 36%, transparent),
        transparent 65%
      );
      animation: drift-b 23s ease-in-out infinite alternate;
    }

    i:nth-child(3) {
      width: 26vmax;
      height: 22vmax;
      right: 16vmax;
      top: -6vmax;
      background: radial-gradient(
        circle,
        color-mix(in srgb, var(--accent) 16%, transparent),
        transparent 65%
      );
      animation: drift-a 27s ease-in-out infinite alternate-reverse;
    }

    @keyframes drift-a {
      to {
        transform: translate(5vmax, 3vmax) scale(1.08);
      }
    }

    @keyframes drift-b {
      to {
        transform: translate(-4vmax, -3vmax) scale(1.06);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host,
      i {
        animation: none;
        transition: none;
      }
    }
  `,
})
export class AuroraSky {
  /** Les lueurs s'éveillent avec l'app plutôt que d'être là d'emblée. */
  readonly lit = input(false);
}
