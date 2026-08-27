import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';

import { CharonGlyph } from '@app/components/brand/charon-logo/charon-glyph';

/**
 * L'écran de traversée : ce qu'on regarde entre le formulaire et l'explorateur.
 *
 * Deux temps. Pendant l'attente, le trajet et des points qui patientent, avec
 * de quoi renoncer. À l'arrivée, la marque de succès et « Bonne traversée. » ;
 * la destination reste, seuls les points s'en vont, et le bouton garde sa place
 * effacé pour que rien ne remonte d'un cran au moment le plus visible.
 */
@Component({
  selector: 'app-traversal',
  imports: [CharonGlyph],
  template: `
    <div
      class="done"
      [class.done--in]="active()"
      [class.done--landed]="landed()"
      [class.done--out]="leaving()"
    >
      <span class="done__glyph"><app-charon-glyph /></span>
      <span class="done__title">
        <span class="done__mark" aria-hidden="true"></span>
        {{ landed() ? 'Bonne traversée.' : 'Traversée en cours' }}
      </span>
      <span class="done__sub"
        >{{ destination() }}@if (!landed()) {<span class="done__dots"></span>}</span
      >
      <button
        type="button"
        class="done__cancel"
        [class.done__cancel--gone]="landed()"
        [disabled]="landed()"
        (click)="cancel.emit()"
      >
        Annuler
      </button>
    </div>
  `,
  styles: `
    /* Surtout pas display: contents ici. Cet écran est un vrai participant de
       la grille de la scène, et les sélecteurs CSS suivent le DOM, pas l'arbre
       de mise en page : la règle .stage > * viserait l'hôte et non le .done,
       qui se retrouverait sur une deuxième ligne au lieu d'être superposé. */
    :host {
      display: block;
    }

    .done {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      text-align: center;
      opacity: 0;
      transform: translateY(14px);
      pointer-events: none;
      /* Croisement serré avec la sortie du panneau : il part en 0,34 s, celle-ci
         démarre à 0,16 s. Les deux se chevauchent au lieu de se succéder. */
      transition:
        opacity 0.42s cubic-bezier(0.2, 1, 0.4, 1) 0.16s,
        transform 0.42s cubic-bezier(0.2, 1, 0.4, 1) 0.16s;
    }

    .done--in {
      opacity: 1;
      transform: none;
      pointer-events: auto;
    }

    /* Le mot dit, l'écran s'efface vers le haut juste avant que l'explorateur
       prenne la main : les deux s'enchaînent au lieu de se couper net. Déclaré
       après .done--in pour l'emporter à spécificité égale. */
    .done--out {
      opacity: 0;
      transform: translateY(-10px);
      transition:
        opacity 0.26s ease,
        transform 0.26s ease;
    }

    .done__glyph {
      display: block;
      width: 46px;
    }

    .done__title {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: calc(20px * var(--text-scale));
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    /* La marque d'arrivée : carrée, en couleur de succès. */
    .done__mark {
      display: none;
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: var(--success);
    }

    .done--landed .done__mark {
      display: block;
    }

    .done__sub {
      min-height: 16px;
      font-family: var(--font-mono);
      font-size: calc(10.5px * var(--text-scale));
      color: var(--text-faint);
    }

    /* Trois points qui se dévoilent l'un après l'autre : l'attente a une couleur. */
    .done__dots::after {
      content: '…';
      display: inline-block;
      color: var(--pending);
      clip-path: inset(0 100% 0 0);
      animation: dots 1.2s steps(4) infinite;
    }

    @keyframes dots {
      to {
        clip-path: inset(0 -6px 0 0);
      }
    }

    .done__cancel {
      margin-top: 6px;
      padding: 8px 20px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      background: none;
      color: var(--text-muted);
      font-size: calc(12px * var(--text-scale));
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.3s ease;
    }

    .done__cancel:hover:not(:disabled) {
      background: var(--state-hover);
      color: var(--text);
    }

    /* À l'arrivée il n'y a plus rien à annuler, mais sa place reste prise. */
    .done__cancel--gone {
      opacity: 0;
      pointer-events: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .done {
        transition: none;
      }

      .done__dots::after {
        animation: none;
        clip-path: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Traversal {
  /** L'annonce a été lue, on libère la place. */
  protected readonly leaving = signal(false);

  constructor() {
    effect(() => {
      if (this.landed()) {
        // Doit être fini avant que l'explorateur apparaisse (voir LANDING_MS).
        setTimeout(() => this.leaving.set(true), 600);
      }
    });
  }

  /** L'écran est à l'écran (attente ou arrivée). */
  readonly active = input(false);
  /** La connexion a abouti : on passe au second temps. */
  readonly landed = input(false);
  readonly destination = input('');

  readonly cancel = output<void>();
}
