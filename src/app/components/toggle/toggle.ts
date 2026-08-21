import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

@Component({
  selector: 'app-toggle',
  templateUrl: './toggle.html',
  styleUrl: './toggle.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Toggle {
  readonly label = input.required<string>();
  readonly checked = model(false);

  protected toggle(): void {
    this.checked.update((value) => !value);
  }
}
