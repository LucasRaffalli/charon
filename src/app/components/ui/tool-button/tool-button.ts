import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';

/**
 * Un bouton d'action de barre : icône + libellé, et le libellé SE REPLIE
 * quand la place manque (l'icône et l'infobulle prennent le relais), plus
 * jamais de « Supprim… » tronqué dans un panneau étroit.
 *
 * Le repli est une container query : le CONSOMMATEUR déclare sa barre comme
 * conteneur, et sous le seuil les libellés disparaissent d'un bloc : une
 * barre où la moitié des boutons serait repliée se lirait mal. Deux gabarits,
 * choisis par le NOM du conteneur :
 * - `container: toolstrip / inline-size` : repli sous 400 px (barre aérée) ;
 * - `container: toolstrip-dense / inline-size` : repli sous 560 px (barre
 *   chargée : l'en-tête de l'aperçu porte chemin, méta et cinq actions, les
 *   libellés n'y ont leur place que vraiment au large).
 */
@Component({
  selector: 'app-tool-button',
  imports: [Icon],
  template: `
    <button
      type="button"
      class="tb"
      [class.tb--danger]="danger()"
      [class.tb--accent]="accent()"
      [disabled]="disabled()"
      [title]="label()"
      [attr.aria-label]="label()"
      (click)="pressed.emit($event)"
    >
      <app-icon [name]="icon()" [size]="13" />
      <span class="tb__label">{{ label() }}</span>
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      min-width: 0;
    }

    .tb {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      padding: 3px 9px;
      border: none;
      border-radius: var(--radius-sm);
      background: none;
      color: var(--text-muted);
      font-family: inherit;
      font-size: calc(11.5px * var(--text-scale));
      font-weight: 600;
      cursor: pointer;

      &:hover:not(:disabled) {
        background: var(--state-hover);
        color: var(--text);
      }

      &:disabled {
        opacity: 0.45;
        cursor: default;
      }

      &--danger:hover:not(:disabled) {
        background: var(--danger-bg, color-mix(in srgb, var(--danger) 14%, transparent));
        color: var(--danger);
      }

      // L'action principale d'une barre : fond accent, même gabarit.
      &--accent {
        background: var(--accent-solid);
        color: var(--text-inverse);

        &:hover:not(:disabled) {
          background: var(--accent-solid-hover, var(--accent-solid));
          color: var(--text-inverse);
        }
      }
    }

    .tb__label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @container toolstrip (max-width: 400px) {
      .tb__label {
        display: none;
      }
    }

    @container toolstrip-dense (max-width: 560px) {
      .tb__label {
        display: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolButton {
  readonly icon = input.required<IconName>();
  readonly label = input.required<string>();
  readonly danger = input(false);
  readonly accent = input(false);
  readonly disabled = input(false);
  readonly pressed = output<MouseEvent>();
}
