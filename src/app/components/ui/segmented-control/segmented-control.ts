import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

export interface SegmentedOption {
  value: string;
  label: string;
  /** Teinte particulière d'un segment (ex. « Prod » en rouge). */
  tone?: 'danger';
}

/**
 * Contrôle segmenté à pastille glissante (choix unique).
 * Les segments ont des largeurs égales : la pastille se translate d'un cran
 * par segment. Réutilisé pour le switch Connexion/Serveurs et les sélecteurs
 * protocole / environnement / garde-fou de la page de connexion.
 */
@Component({
  selector: 'app-segmented-control',
  templateUrl: './segmented-control.html',
  styleUrl: './segmented-control.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SegmentedControl {
  readonly options = input.required<readonly SegmentedOption[]>();
  readonly value = model.required<string>();
  /** Petit libellé affiché au-dessus du contrôle (optionnel). */
  readonly label = input('');
  /** Libellé accessible du groupe radio. */
  readonly ariaLabel = input('');

  /** Index du segment actif : pilote la position de la pastille. */
  protected readonly activeIndex = computed(() =>
    Math.max(
      0,
      this.options().findIndex((option) => option.value === this.value()),
    ),
  );

  protected select(value: string): void {
    this.value.set(value);
  }
}
