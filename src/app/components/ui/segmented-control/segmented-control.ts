import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  model,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';

export interface SegmentedOption {
  value: string;
  label: string;
  /** Teinte particulière d'un segment (ex. « Prod » en rouge). */
  tone?: 'danger';
}

/**
 * Aspect du contrôle.
 *
 * `default` : segments à largeur égale, pastille glissante. Le contrôle de
 * réglage classique.
 *
 * `solid` et `chip` : segments à largeur de contenu, l'actif est un aplat
 * clair à texte inversé. Ils se posent en bout de ligne sans réserver de
 * place, d'où leur emploi dans les titres de section de la connexion.
 * `chip` est la version courte.
 */
export type SegmentedVariant = 'default' | 'solid' | 'chip';

/**
 * Contrôle segmenté à pastille glissante (choix unique).
 * Les segments ont des largeurs égales : la pastille se translate d'un cran
 * par segment. Réutilisé pour le switch Connexion/Serveurs et les sélecteurs
 * protocole / environnement / garde-fou de la page de connexion.
 */
@Component({
  selector: 'app-segmented-control',
  host: {
    '[class.seg--solid]': "variant() !== 'default'",
    '[class.seg--chip]': "variant() === 'chip'",
  },
  templateUrl: './segmented-control.html',
  styleUrl: './segmented-control.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SegmentedControl {
  readonly options = input.required<readonly SegmentedOption[]>();
  readonly variant = input<SegmentedVariant>('default');
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

  private readonly track = viewChild<ElementRef<HTMLElement>>('track');
  private readonly segments = viewChildren<ElementRef<HTMLButtonElement>>('segment');

  /**
   * Position et largeur de la pastille, mesurées sur le segment actif.
   *
   * Mesurées et non calculées : les variantes à largeur de contenu n'ont pas
   * des segments égaux, une simple division ne marcherait que pour le défaut.
   */
  protected readonly pill = signal({ left: 0, width: 0 });

  constructor() {
    // Après chaque rendu où le choix ou les options ont changé.
    afterRenderEffect(() => {
      this.value();
      this.options();
      this.measure();
    });

    // Et quand la largeur bouge sans que rien n'ait changé : police chargée,
    // taille de texte modifiée, fenêtre redimensionnée.
    afterNextRender(() => {
      const host = this.track()?.nativeElement;
      if (!host) {
        return;
      }
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(host);
      inject(DestroyRef).onDestroy(() => observer.disconnect());
    });
  }

  private measure(): void {
    const element = this.segments()[this.activeIndex()]?.nativeElement;
    if (element) {
      this.pill.set({ left: element.offsetLeft, width: element.offsetWidth });
    }
  }

  protected select(value: string): void {
    this.value.set(value);
  }
}
