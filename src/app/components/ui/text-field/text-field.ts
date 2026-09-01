import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

import { InputField } from '@app/components/ui/input/input';

/**
 * Un champ avec son libellé et son habillage. La saisie elle-même est déléguée
 * à `InputField`, qui porte la garde de composition : voir son en-tête.
 */
@Component({
  selector: 'app-text-field',
  imports: [InputField],
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
}
