import { DOCUMENT, DestroyRef, Injectable, inject } from '@angular/core';

import { ThemeService } from '@app/services/appearance/theme.service';

/**
 * La séquence qui réveille l'accent caché. Elle n'est écrite nulle part dans
 * l'interface.
 *
 * Le mot seul ne suffisait pas : « unicorn » peut se taper sans y penser dans
 * un champ de recherche ou un terminal, et l'accent basculait alors sans qu'on
 * l'ait demandé. Il est maintenant encadré de deux motifs de flèches, qu'on ne
 * produit pas par accident en écrivant.
 */
const SEQUENCE = [
  'arrowup',
  'arrowdown',
  'arrowright',
  ...'unicorn'.split(''),
  'arrowup',
  'arrowdown',
  'arrowleft',
];

/** Au-delà de ce silence, la séquence en cours est oubliée. */
const FORGET_MS = 1500;

/**
 * L'accent caché ne s'obtient qu'en tapant sa séquence, n'importe où dans
 * Charon : l'explorateur, la palette, un champ, le terminal. Il n'apparaît dans
 * aucune liste, aucun réglage, aucune commande. Pour en sortir, on choisit un
 * autre accent dans les réglages.
 */
@Injectable({ providedIn: 'root' })
export class SecretAccentService {
  private readonly document = inject(DOCUMENT);
  private readonly theme = inject(ThemeService);

  /** Où l'on en est dans la séquence. */
  private progress = 0;
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

    const key = event.key.toLowerCase();
    // Une lettre ou une flèche, rien d'autre : les modificateurs relâchés et
    // les touches mortes ne doivent ni avancer ni casser la séquence.
    const relevant = key.startsWith('arrow') || (key.length === 1 && /[a-z]/.test(key));
    if (!relevant) {
      return;
    }

    if (key === SEQUENCE[this.progress]) {
      this.progress++;
      this.restartTimer();
      if (this.progress === SEQUENCE.length) {
        this.reset();
        this.theme.activateSecretAccent();
      }
      return;
    }

    // Faux pas : on repart de zéro, mais cette touche peut elle-même être le
    // premier pas suivant — sinon une flèche haut ratée en interdirait une
    // seconde tout de suite après.
    this.reset();
    if (key === SEQUENCE[0]) {
      this.progress = 1;
      this.restartTimer();
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
    this.progress = 0;
    this.clearTimer();
  }
}
