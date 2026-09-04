import { DOCUMENT, DestroyRef, Injectable, inject } from '@angular/core';

import { CustomThemeService } from '@app/services/appearance/custom-theme.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { TranslationKey, injectT } from '@app/lang/i18n.service';
import { ThemeService } from '@app/services/appearance/theme.service';

/**
 * Les séquences cachées de Charon. Elles ne sont écrites nulle part dans
 * l'interface.
 *
 * Le mot seul ne suffit pas : « unicorn » peut se taper sans y penser dans un
 * champ de recherche ou un terminal, et l'accent basculait alors sans qu'on
 * l'ait demandé. Chaque code est donc encadré de deux motifs de flèches,
 * qu'on ne produit pas par accident en écrivant.
 */
/** Les codes cachés de Charon, et ce qu'ils réveillent. */
interface SecretCode {
  keys: string[];
  unlock: () => void;
}

/** Au-delà de ce silence, la séquence en cours est oubliée. */
const FORGET_MS = 1500;

/** Décode les lettres sans conserver les mots secrets dans le bundle source. */
const secretLetters = (encoded: readonly number[]): string[] => encoded.map((value) => String.fromCharCode(value ^ 0x5a));

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
  private readonly custom = inject(CustomThemeService);
  private readonly toasts = inject(ToastService);
  private readonly t = injectT();

  /**
   * Les codes, et l'avancée de chacun. Un seul écouteur pour tous : la
   * mécanique délicate (le faux pas qui peut être le premier pas suivant,
   * l'oubli après un silence, le modificateur qui coupe) n'existe qu'en un
   * exemplaire, et un deuxième code n'ajoute qu'une ligne.
   */
  private readonly codes: SecretCode[] = [
    {
      keys: ['arrowup', 'arrowdown', 'arrowright', ...secretLetters([47, 52, 51, 57, 53, 40, 52]), 'arrowup', 'arrowdown', 'arrowleft'],
      unlock: () => {
        this.theme.activateSecretAccent();
        this.announce('secrets.unicorn', 'secrets.unicornHint');
      },
    },
    {
      keys: ['arrowleft', 'arrowright', 'arrowup', ...secretLetters([41, 46, 59, 40, 41]), 'arrowleft', 'arrowright', 'arrowdown'],
      unlock: () => {
        this.theme.activateSecretAccent('stars');
        this.announce('secrets.stars', 'secrets.starsHint');
      },
    },
    {
      // L'atelier : le panneau design avancé, où l'on fabrique son thème.
      keys: ['arrowdown', 'arrowup', 'arrowleft', ...secretLetters([57, 40, 59, 60, 46]), 'arrowdown', 'arrowup', 'arrowright'],
      unlock: () => {
        const known = this.custom.unlocked();
        this.custom.unlock();
        // Retapé alors qu'il est déjà ouvert : on le dit autrement plutôt
        // que de fêter deux fois la même découverte.
        this.announce('secrets.craft', known ? 'secrets.craftAgain' : 'secrets.craftHint');
      },
    },
  ];
  private progress: number[] = this.codes.map(() => 0);
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

    let advancing = false;
    this.codes.forEach((code, index) => {
      if (key === code.keys[this.progress[index]]) {
        this.progress[index]++;
        advancing = true;
        if (this.progress[index] === code.keys.length) {
          this.progress[index] = 0;
          code.unlock();
        }
        return;
      }
      // Faux pas : ce code repart de zéro, mais cette touche peut elle-même
      // être son premier pas — sinon une flèche haut ratée en interdirait une
      // seconde tout de suite après.
      this.progress[index] = key === code.keys[0] ? 1 : 0;
      if (this.progress[index] === 1) {
        advancing = true;
      }
    });

    if (advancing) {
      this.restartTimer();
    } else {
      this.reset();
    }
  };

  /**
   * Un code qui aboutit se dit.
   *
   * Sans retour, on ne sait pas si on a mal tapé ou si rien n'existe — et
   * l'accent caché est le seul des deux dont l'effet saute aux yeux ; le
   * mode atelier, lui, ne se voit qu'une fois le mode design ouvert. Clé
   * fixe : retaper un code remplace son toast au lieu de les empiler.
   */
  private announce(title: TranslationKey, detail: TranslationKey): void {
    this.toasts.success(this.t(title), { detail: this.t(detail), key: 'secret-code' });
  }

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
    this.progress = this.codes.map(() => 0);
    this.clearTimer();
  }
}
