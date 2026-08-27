import { Injectable, signal } from '@angular/core';

export interface DialogState {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  confirmLabel: string;
  danger?: boolean;
  value?: string;
  placeholder?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  value?: string;
  placeholder?: string;
}

/** Dialogues confirm/prompt sous forme de promesses, rendus par DialogHost. */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private readonly _state = signal<DialogState | null>(null);
  private resolver: ((result: boolean | string | null) => void) | null = null;

  readonly state = this._state.asReadonly();

  confirm(options: ConfirmOptions): Promise<boolean> {
    this.cancelPending();
    this._state.set({
      kind: 'confirm',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? 'Confirmer',
      danger: options.danger,
    });
    return new Promise((resolve) => {
      this.resolver = (result) => resolve(result === true);
    });
  }

  prompt(options: PromptOptions): Promise<string | null> {
    this.cancelPending();
    this._state.set({
      kind: 'prompt',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? 'Valider',
      danger: options.danger,
      value: options.value,
      placeholder: options.placeholder,
    });
    return new Promise((resolve) => {
      this.resolver = (result) => resolve(typeof result === 'string' ? result : null);
    });
  }

  /** Ferme le dialogue en résolvant sa promesse. */
  settle(result: boolean | string | null): void {
    const resolver = this.resolver;
    this.resolver = null;
    this._state.set(null);
    resolver?.(result);
  }

  private cancelPending(): void {
    if (this.resolver) {
      this.settle(null);
    }
  }
}
