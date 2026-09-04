import { Injectable, signal } from '@angular/core';

export interface DialogState {
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  confirmLabel: string;
  danger?: boolean;
  value?: string;
  placeholder?: string;
  /** Libellé d'une case à cocher qui doit être cochée avant de pouvoir
   *  confirmer. Remplace le mot à retaper pour un lot : un geste explicite
   *  plutôt qu'une saisie, mais qui reste un geste, pas un clic distrait. */
  acknowledge?: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Voir `DialogState.acknowledge`. */
  acknowledge?: string;
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
      acknowledge: options.acknowledge,
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
