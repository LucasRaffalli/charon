import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { GradientSpot, MAX_SPOTS, SpotShape } from '@app/interfaces';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { AppearanceService } from '@app/services/appearance/appearance.service';
import { injectT } from '@app/lang/i18n.service';

/**
 * L'éditeur du dégradé libre : des sources de lumière qu'on attrape et qu'on
 * pose, jusqu'à six, de quatre formes.
 *
 * Composant à part et non un morceau de `DesignPanel` : la carte dépassait le
 * budget de styles du projet, et la règle maison est d'EXTRAIRE plutôt que de
 * relever le budget. L'éditeur s'y prêtait bien, il ne dépend de rien de la
 * carte (ni de son glissé, ni de son redimensionnement).
 */
@Component({
  selector: 'app-spots-editor',
  imports: [SegmentedControl],
  templateUrl: './spots-editor.html',
  styleUrl: './spots-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SpotsEditor {
  protected readonly t = injectT();
  protected readonly appearance = inject(AppearanceService);

  /**
   * L'ajusteur du dégradé libre : on attrape une source de lumière et on la
   * pose.
   *
   * Le clic hors d'une source sélectionne et déplace la PLUS PROCHE plutôt
   * que de ne rien faire : viser une pastille de treize pixels à la souris
   * est pénible, et l'intention (« la lumière, ici ») ne fait aucun doute.
   */
  private readonly spotsBox = viewChild<ElementRef<HTMLElement>>('spotsBox');
  private dragging = false;

  protected readonly maxSpots = MAX_SPOTS;
  /** La source réglée par les curseurs du dessous. */
  protected readonly selectedSpot = signal(0);

  protected readonly shapeOptions: readonly SegmentedOption[] = [
    { value: 'spot', label: this.t('design.shape.spot') },
    { value: 'beam', label: this.t('design.shape.beam') },
    { value: 'edge', label: this.t('design.shape.edge') },
    { value: 'ring', label: this.t('design.shape.ring') },
  ];

  /** La source sélectionnée, ou la première si l'index a glissé (un retrait
   *  peut laisser la sélection au-delà de la fin). */
  protected readonly currentSpot = computed<GradientSpot | null>(() => {
    const spots = this.appearance.spots();
    return spots[this.selectedSpot()] ?? spots[0] ?? null;
  });

  /** Le nom d'une forme. Par une méthode et non une clé concaténée dans le
   *  gabarit : `TranslationKey` est un type littéral, une clé assemblée à
   *  l'exécution n'en fait pas partie et ne serait plus vérifiée. */
  protected shapeLabel(shape: SpotShape): string {
    switch (shape) {
      case 'beam':
        return this.t('design.shape.beam');
      case 'edge':
        return this.t('design.shape.edge');
      case 'ring':
        return this.t('design.shape.ring');
      default:
        return this.t('design.shape.spot');
    }
  }

  protected addSpot(): void {
    const spots = this.appearance.spots();
    if (spots.length >= MAX_SPOTS) {
      return;
    }
    // La nouvelle source naît au centre, dans la couleur la moins employée :
    // deux lumières identiques posées l'une sur l'autre ne se voient pas.
    const usingB = spots.filter((spot) => spot.color === 1).length;
    const next: GradientSpot = {
      shape: 'spot',
      x: 50,
      y: 50,
      size: 45,
      angle: 112,
      color: usingB * 2 < spots.length ? 1 : 0,
      tint: null,
      alpha: 100,
    };
    this.appearance.update({ spots: [...spots.map((spot) => ({ ...spot })), next] });
    this.selectedSpot.set(spots.length);
  }

  protected removeSpot(): void {
    const spots = this.appearance.spots();
    if (spots.length <= 1) {
      return;
    }
    const index = Math.min(this.selectedSpot(), spots.length - 1);
    this.appearance.update({
      spots: spots.filter((_, at) => at !== index).map((spot) => ({ ...spot })),
    });
    this.selectedSpot.set(Math.max(0, index - 1));
  }

  protected setSpotShape(value: string): void {
    this.patchSpot({ shape: value as SpotShape });
  }

  protected setSpotField(key: 'size' | 'angle' | 'alpha', event: Event): void {
    const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
    if (Number.isFinite(value)) {
      this.patchSpot({ [key]: value });
    }
  }

  /** Bascule la source entre les deux couleurs du dégradé. Sans effet tant
   *  qu'elle a une couleur propre : c'est celle-là qui gagne. */
  protected swapSpotColor(): void {
    this.patchSpot({ color: this.currentSpot()?.color === 1 ? 0 : 1 });
  }

  /** La couleur montrée par le sélecteur : celle de la source si elle en a
   *  une, sinon celle du dégradé qu'elle suit. */
  protected spotTint(): string {
    const spot = this.currentSpot();
    if (spot?.tint) {
      return spot.tint;
    }
    const colors = this.appearance.effectiveColors();
    return spot?.color === 1 ? colors.to : colors.from;
  }

  protected setSpotTint(event: Event): void {
    this.patchSpot({ tint: (event.target as HTMLInputElement).value });
  }

  /** Rendre la source aux couleurs du dégradé : elle redevient solidaire. */
  protected clearSpotTint(): void {
    this.patchSpot({ tint: null });
  }

  private patchSpot(patch: Partial<GradientSpot>): void {
    const index = Math.min(this.selectedSpot(), this.appearance.spots().length - 1);
    this.appearance.update({
      spots: this.appearance
        .spots()
        .map((spot, at) => (at === index ? { ...spot, ...patch } : { ...spot })),
    });
  }

  protected onSpotDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    const point = this.spotPoint(event);
    if (!point) {
      return;
    }
    const spots = this.appearance.spots();
    const target = (event.target as HTMLElement).dataset?.['spot'];
    const index =
      target !== undefined
        ? Number(target)
        : spots.reduce(
            (best: number, spot, at: number) =>
              Math.hypot(spot.x - point.x, spot.y - point.y) <
              Math.hypot(spots[best].x - point.x, spots[best].y - point.y)
                ? at
                : best,
            0,
          );
    this.selectedSpot.set(index);
    this.dragging = true;
    this.moveSpot(point);
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  protected onSpotMove(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    const point = this.spotPoint(event);
    if (point) {
      this.moveSpot(point);
    }
  }

  protected onSpotUp(event: PointerEvent): void {
    this.dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  /** Le point du curseur, en pourcentages de l'aperçu. Débordement permis :
   *  une lumière posée hors cadre éclaire encore le bord, et c'est utile. */
  private spotPoint(event: PointerEvent): { x: number; y: number } | null {
    const box = this.spotsBox()?.nativeElement;
    if (!box) {
      return null;
    }
    const rect = box.getBoundingClientRect();
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * 100, -20, 120),
      y: clamp(((event.clientY - rect.top) / rect.height) * 100, -20, 120),
    };
  }

  private moveSpot(point: { x: number; y: number }): void {
    this.patchSpot({ x: Math.round(point.x), y: Math.round(point.y) });
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
