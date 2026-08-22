import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

@Component({
  selector: 'app-toggle',
  templateUrl: './toggle.html',
  styleUrl: './toggle.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Toggle {
  /** Libellé à gauche du switch ; vide = switch seul (ligne de réglage). */
  readonly label = input('');
  readonly checked = model(false);

  protected toggle(): void {
    this.checked.update((value) => !value);
  }
}
