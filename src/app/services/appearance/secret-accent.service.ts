import { DOCUMENT, DestroyRef, Injectable, inject } from '@angular/core';

import { ThemeService } from '@app/services/appearance/theme.service';

/** Le mot qui réveille l'accent caché. Il n'est écrit nulle part dans l'UI. */
const CODE = 'unicorn';

/** Au-delà de ce silence, la saisie en cours est oubliée. */
const FORGET_MS = 1500;

/**
 * L'accent caché ne s'obtient qu'en tapant son nom, n'importe où dans Charon :
 * l'explorateur, la palette, un champ, le terminal. Il n'apparaît dans aucune
 * liste, aucun réglage, aucune commande. Pour en sortir, on choisit un autre
 * accent dans les réglages.
 */
@Injectable({ providedIn: 'root' })
export class SecretAccentService {
  private readonly document = inject(DOCUMENT);
  private readonly theme = inject(ThemeService);

  private typed = '';
  private timer = 0;

  constructor() {
    this.document.addEventListener('keydown', this.onKeydown);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('keydown', this.onKeydown);
      this.clearTimer();
    });
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    // Un raccourci n'est pas une saisie : il coupe la séquence en cours.
    if (event.metaKey || event.ctrlKey || event.altKey) {
      this.reset();
      return;
    }
    if (event.key.length !== 1 || !/[a-zA-Z]/.test(event.key)) {
      return;
    }

    this.typed = (this.typed + event.key.toLowerCase()).slice(-CODE.length);
    this.restartTimer();

    if (this.typed === CODE) {
      this.reset();
      this.theme.activateSecretAccent();
    }
  };

  private restartTimer(): void {
    const view = this.document.defaultView;
    if (!view) {
      return;
    }
    this.clearTimer();
    this.timer = view.setTimeout(() => this.reset(), FORGET_MS);
  }

  private clearTimer(): void {
    if (this.timer) {
      this.document.defaultView?.clearTimeout(this.timer);
      this.timer = 0;
    }
  }

  private reset(): void {
    this.typed = '';
    this.clearTimer();
  }
}
