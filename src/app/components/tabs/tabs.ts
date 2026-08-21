import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  booleanAttribute,
  computed,
  effect,
  input,
  model,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';

import { Icon, IconName } from '@app/components/icon/icon';

export interface TabItem {
  id: string;
  label: string;
  icon?: IconName;
}

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Barre d'onglets à coins inversés : un indicateur unique (fond + raccords
 * concaves) **glisse** d'un onglet à l'autre, le contenu suit avec un
 * glissement directionnel et la hauteur du panneau s'anime entre deux
 * contenus de tailles différentes (pas de cassure).
 * Un onglet en limite du panneau se colle à 100 % au bord (pas de coin
 * inversé côté bord, coin du panneau carré).
 * Personnalisable via `--tabs-bg` (fond commun indicateur + panneau)
 * et `--tabs-radius`.
 */
@Component({
  selector: 'app-tabs',
  imports: [Icon],
  templateUrl: './tabs.html',
  styleUrl: './tabs.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:resize)': 'positionIndicator()' },
})
export class Tabs {
  readonly tabs = input.required<TabItem[]>();
  readonly active = model.required<string>();
  /** Étire les onglets sur toute la largeur (le dernier colle au bord droit). */
  readonly stretch = input(false, { transform: booleanAttribute });
  /** Replie le panneau : seule la barre d'onglets reste visible. */
  readonly collapsed = input(false, { transform: booleanAttribute });
  /** Émis à CHAQUE clic d'onglet, même déjà actif (utile pour déplier). */
  readonly tabClick = output<string>();

  protected readonly activeIsFirst = computed(() => this.tabs()[0]?.id === this.active());
  protected readonly activeIsLast = computed(
    () => this.tabs()[this.tabs().length - 1]?.id === this.active(),
  );

  /** true après le positionnement initial : active la transition de l'indicateur. */
  protected readonly indicatorReady = signal(false);

  private readonly indicator = viewChild.required<ElementRef<HTMLElement>>('indicator');
  // Optionnel : absent quand le panneau est replié.
  private readonly content = viewChild<ElementRef<HTMLElement>>('content');
  private readonly buttons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  private previousIndex: number | null = null;

  protected select(id: string): void {
    this.active.set(id);
    this.tabClick.emit(id);
  }
  private lastContentHeight: number | null = null;

  constructor() {
    afterNextRender(() => {
      this.positionIndicator();
      this.lastContentHeight = this.content()?.nativeElement.offsetHeight ?? null;
      requestAnimationFrame(() => this.indicatorReady.set(true));
    });

    // Les libellés peuvent changer de largeur (ex : compteur « Transferts · 2 ») :
    // re-mesurer l'indicateur après le rendu du nouveau texte, sinon il
    // garde l'ancienne largeur et empiète sur les onglets voisins.
    effect(() => {
      this.tabs();
      this.active();
      requestAnimationFrame(() => this.positionIndicator());
    });

    effect(() => {
      const index = this.tabs().findIndex((tab) => tab.id === this.active());
      if (index === -1) {
        return;
      }
      if (this.previousIndex === null) {
        this.previousIndex = index;
        return;
      }
      if (index === this.previousIndex) {
        return;
      }
      const direction = index > this.previousIndex ? 1 : -1;
      this.previousIndex = index;
      // Après le rendu du nouveau contenu : glisse l'indicateur, anime la
      // hauteur ancienne → nouvelle et fait entrer le contenu par le bon côté.
      requestAnimationFrame(() => {
        this.positionIndicator();
        this.animateContent(direction);
      });
    });
  }

  /** Aligne l'indicateur sur l'onglet actif (glisse si la transition est armée). */
  protected positionIndicator(): void {
    const index = this.tabs().findIndex((tab) => tab.id === this.active());
    const button = this.buttons()[index]?.nativeElement;
    if (!button) {
      return;
    }
    const style = this.indicator().nativeElement.style;
    style.left = `${button.offsetLeft}px`;
    style.width = `${button.offsetWidth}px`;
  }

  private animateContent(direction: number): void {
    const element = this.content()?.nativeElement;
    if (!element) {
      this.lastContentHeight = null;
      return;
    }
    const newHeight = element.offsetHeight;
    const oldHeight = this.lastContentHeight;
    this.lastContentHeight = newHeight;

    if (reducedMotion()) {
      return;
    }
    if (oldHeight !== null && oldHeight !== newHeight) {
      element.animate(
        [{ height: `${oldHeight}px` }, { height: `${newHeight}px` }],
        { duration: 220, easing: 'ease' },
      );
    }
    element.animate(
      [
        { opacity: 0, transform: `translateX(${direction * 18}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 200, easing: 'ease-out' },
    );
  }
}
