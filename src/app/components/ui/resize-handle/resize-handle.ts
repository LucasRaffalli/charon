import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/**
 * Poignée de redimensionnement. Émet le delta en pixels depuis le début
 * du glissement ; le parent applique la taille (et son clamp) lui-même.
 */
@Component({
  selector: 'app-resize-handle',
  template: '',
  styleUrl: './resize-handle.scss',
  host: {
    '[class.handle--x]': "axis() === 'x'",
    '[class.handle--y]': "axis() === 'y'",
    '[class.handle--active]': 'dragging()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResizeHandle {
  /** Axe du déplacement : x = largeur, y = hauteur. */
  readonly axis = input<'x' | 'y'>('x');

  readonly dragStarted = output<void>();
  readonly dragged = output<number>();
  readonly dragEnded = output<void>();

  protected readonly dragging = signal(false);
  private origin = 0;

  protected onPointerDown(event: PointerEvent): void {
    event.preventDefault();
    this.dragging.set(true);
    this.origin = this.axis() === 'x' ? event.clientX : event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragStarted.emit();
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging()) {
      return;
    }
    const position = this.axis() === 'x' ? event.clientX : event.clientY;
    this.dragged.emit(position - this.origin);
  }

  protected onPointerUp(event: PointerEvent): void {
    if (!this.dragging()) {
      return;
    }
    this.dragging.set(false);
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    this.dragEnded.emit();
  }
}
