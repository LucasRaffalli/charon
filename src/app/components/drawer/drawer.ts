import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  signal,
} from '@angular/core';

const CLICK_THRESHOLD = 5;

/**
 * Tiroir latéral gauche masquable, avec poignée : clic pour ouvrir/fermer,
 * glisser pour l'amener où on veut (aimanté ouvert/fermé au relâcher).
 */
@Component({
  selector: 'app-drawer',
  templateUrl: './drawer.html',
  styleUrl: './drawer.scss',
  host: {
    '(document:keydown.escape)': 'closeIfOpen()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Drawer {
  readonly label = input('Panneau latéral');
  readonly width = input(280);
  readonly open = model(false);

  /** Translation pendant un glissement, null au repos. */
  protected readonly dragOffset = signal<number | null>(null);
  protected readonly translate = computed(
    () => this.dragOffset() ?? (this.open() ? 0 : -this.width()),
  );

  private dragging = false;
  private moved = false;
  private suppressClick = false;
  private startX = 0;
  private startTranslate = 0;

  protected onClick(): void {
    // Un glissement vient de se terminer : le click qui suit n'est pas un vrai clic.
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.open.update((value) => !value);
  }

  protected onPointerDown(event: PointerEvent): void {
    this.dragging = true;
    this.moved = false;
    this.startX = event.clientX;
    this.startTranslate = this.translate();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    const delta = event.clientX - this.startX;
    if (Math.abs(delta) > CLICK_THRESHOLD) {
      this.moved = true;
    }
    if (this.moved) {
      this.dragOffset.set(Math.min(0, Math.max(-this.width(), this.startTranslate + delta)));
    }
  }

  protected onPointerUp(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;

    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }

    if (this.moved) {
      this.suppressClick = true;
      this.open.set((this.dragOffset() ?? -this.width()) > -this.width() / 2);
    }
    this.dragOffset.set(null);
  }

  protected closeIfOpen(): void {
    if (this.open()) {
      this.open.set(false);
    }
  }
}
