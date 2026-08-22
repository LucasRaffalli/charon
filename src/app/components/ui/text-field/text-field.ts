import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

@Component({
  selector: 'app-text-field',
  templateUrl: './text-field.html',
  styleUrl: './text-field.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TextField {
  /** Libellé au-dessus du champ ; vide = champ seul (ligne de réglage). */
  readonly label = input('');
  /** Nom accessible quand le libellé visuel est porté ailleurs (ligne de réglage). */
  readonly ariaLabel = input('');
  /** Prend le focus à l'apparition (ex. champ d'un dialogue). */
  readonly autofocus = input(false);
  readonly type = input<'text' | 'password' | 'number'>('text');
  readonly name = input('');
  readonly placeholder = input('');
  readonly hint = input('');
  readonly autocomplete = input('off');

  readonly value = model('');

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }
}
