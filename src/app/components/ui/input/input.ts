import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, input, model, signal, viewChild } from '@angular/core';

/**
 * Le champ de saisie de Charon, et le seul endroit où l'application parle à un
 * `<input>`.
 *
 * Il existe pour une raison qui ne se voit pas à la lecture : tous nos champs
 * sont pilotés par un signal (`[value]` en entrée, l'événement de saisie en
 * sortie), et ce patron a un angle mort. Certaines saisies ne produisent pas
 * un caractère d'un coup, elles le COMPOSENT : une touche morte (`^` puis `e`
 * pour `ê`, quotidien sur un clavier français), le visualiseur de caractères
 * de macOS, un appui long sur une voyelle, une saisie asiatique. Le texte est
 * alors en fabrication dans le champ, marqué mais pas encore validé, et lui
 * réassigner sa valeur interrompt la fabrication : on obtient `^e` au lieu de
 * `ê`. La garde ci-dessous laisse le champ tranquille jusqu'à la validation.
 *
 * Le défaut était partout, puisque le patron était partout. Le corriger dans
 * un composant plutôt que dans huit fichiers est le seul moyen qu'il reste
 * corrigé : un champ écrit demain hérite de la garde sans que personne ait à
 * se souvenir qu'elle existe.
 *
 * Habillage : c'est l'HÔTE qui le porte, pas le champ. Le style d'un panneau
 * est encapsulé dans ce panneau et ne franchit pas la frontière d'un autre
 * composant ; posé sur `<app-input class="…">`, il s'applique en revanche
 * normalement. Le champ à l'intérieur n'est donc qu'une zone de saisie nue
 * qui hérite de tout et remplit son hôte. Deux conséquences pour qui migre un
 * champ existant : `:focus` devient `:focus-within` (c'est le champ qui
 * reçoit le focus, pas l'hôte), et `::placeholder` n'a plus à être déclaré,
 * il est défini ici pour tout le monde.
 */
@Component({
  selector: 'app-input',
  template: `
    <input
      #el
      [type]="type()"
      [value]="value()"
      [placeholder]="placeholder()"
      [readOnly]="readonly()"
      [attr.name]="name() || null"
      [attr.aria-label]="ariaLabel() || null"
      [attr.autocomplete]="autocomplete()"
      [attr.inputmode]="inputmode() || null"
      spellcheck="false"
      autocorrect="off"
      autocapitalize="off"
      (input)="onInput($event)"
      (compositionstart)="composing.set(true)"
      (compositionend)="onCompositionEnd($event)"
    />
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    input {
      flex: 1;
      min-width: 0;
      margin: 0;
      padding: 0;
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      letter-spacing: inherit;
      outline: none;
    }

    input::placeholder {
      color: var(--text-faint);
    }

    /* Pas de compteur sur les champs numériques : deux flèches minuscules
       qui apparaissent au survol, dans une interface qui n'en veut nulle
       part. */
    input[type='number'] {
      appearance: textfield;
    }

    input::-webkit-outer-spin-button,
    input::-webkit-inner-spin-button {
      -webkit-appearance: none;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InputField {
  readonly value = model('');
  readonly type = input<'text' | 'password' | 'number' | 'search'>('text');
  readonly placeholder = input('');
  /** Nom accessible quand le libellé visuel est porté ailleurs. */
  readonly ariaLabel = input('');
  readonly name = input('');
  readonly autocomplete = input('off');
  readonly inputmode = input('');
  readonly readonly = input(false);
  /** Prend le focus à l'apparition (champ d'un dialogue, filtre qu'on déplie). */
  readonly autofocus = input(false);

  private readonly el = viewChild.required<ElementRef<HTMLInputElement>>('el');

  /** Une composition est en cours : voir l'explication en tête de fichier. */
  protected readonly composing = signal(false);

  constructor() {
    afterNextRender(() => {
      if (this.autofocus()) {
        this.el().nativeElement.focus();
      }
    });
  }

  /**
   * Donne le focus au champ. Les appelants passaient jusqu'ici par une
   * référence de gabarit vers l'élément natif ; ils visent maintenant le
   * composant, qui n'expose que ce qu'on a le droit de lui demander.
   */
  focus(): void {
    this.el().nativeElement.focus();
  }

  select(): void {
    this.el().nativeElement.select();
  }

  protected onInput(event: Event): void {
    if (this.composing()) {
      return;
    }
    this.value.set((event.target as HTMLInputElement).value);
  }

  /**
   * Fin de composition : le caractère est validé. La valeur est relue ici et
   * pas seulement dans `onInput` car selon le navigateur cet événement arrive
   * APRÈS la dernière saisie, qui a donc été ignorée par la garde.
   */
  protected onCompositionEnd(event: Event): void {
    this.composing.set(false);
    this.value.set((event.target as HTMLInputElement).value);
  }
}
