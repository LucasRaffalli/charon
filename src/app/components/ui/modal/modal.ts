import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject, input, output } from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';

/**
 * Les modales ouvertes, dans l'ordre. Échap ne doit fermer QUE celle du
 * dessus : sans cette pile, une modale ouverte par-dessus une autre les
 * refermerait toutes les deux d'un seul appui. Une pile et non un compteur,
 * pour que des fermetures dans le désordre ne dérèglent pas le compte.
 */
const stack: Modal[] = [];

/**
 * La base commune de toutes les modales de l'app : le voile, la carte, le
 * titre, le pied, Échap, le clic à côté, le retour du focus.
 *
 * Elle existe parce que chaque dialogue redessinait la sienne : cinq voiles à
 * cinq opacités, cinq cartes à cinq largeurs, et Échap qui marchait dans
 * certaines seulement. Ce qui varie d'une modale à l'autre est ici un réglage
 * (taille, titre, pied) ; ce qui ne doit pas varier n'est plus recopié.
 *
 * Le contenu se projette au centre, le pied dans le slot `[modal-foot]`.
 */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  templateUrl: './modal.html',
  styleUrl: './modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Modal {
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  readonly title = input('');
  readonly subtitle = input('');
  readonly icon = input<IconName | null>(null);

  /**
   * Quatre largeurs, pas une valeur libre : des dialogues qui font tous 340,
   * 360 et 375 px ne se ressemblent plus, ils se ratent de peu.
   */
  readonly size = input<'sm' | 'md' | 'lg' | 'xl'>('sm');

  /**
   * `alertdialog` pour une question qui interrompt (confirmation, danger) :
   * les lecteurs d'écran l'annoncent autrement qu'un dialogue ordinaire.
   */
  readonly role = input<'dialog' | 'alertdialog'>('dialog');

  /**
   * La couleur de la pastille d'icône. En `danger`, l'avertissement se lit
   * avant le titre : c'est ce qu'on regarde en premier quand on s'apprête à
   * détruire quelque chose.
   */
  readonly tone = input<'accent' | 'danger'>('accent');

  /** Échap, le clic sur le voile et la croix ferment. */
  readonly dismissible = input(true);

  /** Le corps porte sa gouttière (à couper pour un contenu à bord perdu). */
  readonly padded = input(true);

  readonly closed = output<void>();

  constructor() {
    // Le focus entre dans la carte, puis revient d'où il venait : sans ça une
    // modale fermée laisse le clavier nulle part, et la touche suivante part
    // dans la page derrière.
    const returnTo = document.activeElement as HTMLElement | null;
    stack.push(this);
    afterNextRender(() => {
      this.host.nativeElement.querySelector<HTMLElement>('.modal')?.focus({ preventScroll: true });
    });
    inject(DestroyRef).onDestroy(() => {
      stack.splice(stack.indexOf(this), 1);
      returnTo?.focus?.({ preventScroll: true });
    });
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.dismissible() && stack.at(-1) === this) {
      event.stopPropagation();
      this.close();
    }
  }

  protected onScrim(): void {
    if (this.dismissible()) {
      this.close();
    }
  }

  protected close(): void {
    this.closed.emit();
  }
}
