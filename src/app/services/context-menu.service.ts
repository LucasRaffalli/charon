import { Injectable, signal } from '@angular/core';

import { IconName } from '@app/components/icon/icon';

export interface ContextMenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  action: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** Menu contextuel global : un seul menu ouvert à la fois, rendu par ContextMenu. */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  private readonly _state = signal<ContextMenuState | null>(null);

  readonly state = this._state.asReadonly();

  open(event: MouseEvent, items: ContextMenuItem[]): void {
    event.preventDefault();
    event.stopPropagation();
    this._state.set({ x: event.clientX, y: event.clientY, items });
  }

  close(): void {
    this._state.set(null);
  }
}
