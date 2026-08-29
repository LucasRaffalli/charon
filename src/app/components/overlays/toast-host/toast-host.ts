import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  signal,
  viewChildren,
} from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';
import { Toast, ToastKind } from '@app/interfaces';
import { ToastService } from '@app/services/workspace/toast.service';

const KIND_ICONS: Record<ToastKind, IconName> = {
  success: 'check',
  error: 'alert-circle',
  info: 'info',
};

/** Le mot de l'en-tête, quand le toast n'en impose pas un. */
const KIND_WORDS: Record<ToastKind, string> = {
  success: 'Fait',
  error: 'Échec',
  info: 'Info',
};

/** Ce qu'une carte enfouie laisse voir de la carte qui la précède. */
const DEPTH_STEP = 12;

/** Le retrait d'échelle par niveau de profondeur : c'est lui qui fait la pile. */
const DEPTH_SCALE = 0.05;

/** Au-delà, la tranche ne se lirait plus : la carte s'efface. */
const VISIBLE_DEPTH = 3;

/** Espace entre deux cartes dépliées. */
const GAP = 8;

/**
 * La pile des annonces, montée une fois pour toute l'application.
 *
 * Elle vit en bas au centre, seule zone qui ne recouvre rien : la barre
 * d'édition distante tient le coin gauche, le pied de l'explorateur la ligne du
 * dessous.
 *
 * Repliée, une pile de quatre messages tient la place d'un seul : les cartes
 * précédentes ne montrent que leur en-tête, dont la couleur dit déjà de quoi il
 * retourne. Le survol les déplie et suspend tous les comptes à rebours.
 */
@Component({
  selector: 'app-toast-host',
  imports: [Icon],
  templateUrl: './toast-host.html',
  styleUrl: './toast-host.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastHost {
  protected readonly toasts = inject(ToastService);
  protected readonly expanded = signal(false);

  private readonly cards = viewChildren<ElementRef<HTMLElement>>('card');

  constructor() {
    // La disposition se calcule après rendu : elle a besoin des hauteurs
    // réelles, que seul le DOM connaît (un message sur deux lignes n'occupe pas
    // la même place qu'un message court).
    afterRenderEffect(() => {
      const cards = this.cards();
      const open = this.expanded();
      const count = cards.length;
      let offset = 0;

      // Du plus récent (devant, en bas) au plus ancien.
      for (let i = count - 1; i >= 0; i--) {
        const el = cards[i].nativeElement;
        const depth = count - 1 - i;
        if (open) {
          el.style.transform = `translateY(${-offset}px) scale(1)`;
          el.style.opacity = '1';
          el.style.pointerEvents = 'auto';
          offset += el.offsetHeight + GAP;
        } else {
          const buried = depth >= VISIBLE_DEPTH;
          el.style.transform = `translateY(${-depth * DEPTH_STEP}px) scale(${1 - depth * DEPTH_SCALE})`;
          el.style.opacity = buried ? '0' : '1';
          el.style.pointerEvents = buried ? 'none' : 'auto';
        }
        el.style.zIndex = String(100 - depth);
      }

      // La zone de survol se limite à la pile : un conteneur invisible qui
      // capte les clics en bas de l'écran bloquerait la barre de statut le
      // reste du temps.
      const host = cards[count - 1]?.nativeElement;
      const height = open ? offset : (host?.offsetHeight ?? 0) + DEPTH_STEP * Math.min(count - 1, VISIBLE_DEPTH);
      const stack = host?.parentElement;
      if (stack) {
        stack.style.height = `${Math.max(0, height)}px`;
      }
    });
  }

  protected setExpanded(open: boolean): void {
    this.expanded.set(open);
    // Déplier, c'est lire : tout s'arrête, pas seulement la carte survolée.
    if (open) {
      this.toasts.holdAll();
    } else {
      this.toasts.releaseAll();
    }
  }

  /** Le bouton du toast agit, puis le toast s'efface : il a fait son office. */
  protected run(toast: Toast): void {
    toast.action?.run();
    this.toasts.dismiss(toast.id);
  }

  protected iconFor(kind: ToastKind): IconName {
    return KIND_ICONS[kind];
  }

  protected wordFor(kind: ToastKind): string {
    return KIND_WORDS[kind];
  }
}
