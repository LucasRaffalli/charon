import { Injectable, signal } from '@angular/core';

import { Toast, ToastAction, ToastKind } from '@app/interfaces';

/** Combien de temps un toast reste, selon ce qu'il annonce. */
const LIFETIME: Record<ToastKind, number> = {
  success: 3500,
  info: 4500,
  // Un échec se lit, et souvent se recopie : il lui faut le temps qu'il faut.
  error: 9000,
};

/**
 * Au-delà, les plus anciens s'en vont. Empilés, quatre messages tiennent la
 * place d'un seul, mais une pile qui grandit sans fin finit quand même par
 * couvrir l'interface qu'elle commente.
 */
const MAX_VISIBLE = 4;

/** Ce qu'on peut préciser en posant un toast. */
export interface ToastOptions {
  detail?: string | null;
  title?: string | null;
  action?: ToastAction | null;
  /** Ne s'efface pas tout seul : voir `Toast.sticky`. */
  sticky?: boolean;
  /** Identité stable : reposer la même clé remplace au lieu d'empiler. */
  key?: string | null;
  /**
   * Durée sur mesure, en millisecondes. Sert quand le toast porte une action
   * qu'on doit avoir le temps de viser : le barème par nature est calibré pour
   * une annonce qu'on lit, pas pour un bouton qu'on clique.
   */
  life?: number;
}

/** Une minuterie de toast, suspendable : déplier la pile arrête le compte. */
interface Countdown {
  handle: ReturnType<typeof setTimeout> | null;
  /** Ce qu'il reste à courir quand la minuterie est suspendue. */
  remaining: number;
  /** Instant du dernier départ, pour savoir ce qui a été consommé. */
  startedAt: number;
}

/**
 * Les annonces de l'application.
 *
 * Elles servent aux gestes dont le résultat ne se voit nulle part : ancrer un
 * dossier, copier un chemin, enregistrer un fichier dont le contenu à l'écran
 * ne change pas. Un geste qui déplace l'explorateur ou fait apparaître une
 * ligne se commente tout seul et n'a rien à faire ici.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  private nextId = 1;
  private readonly countdowns = new Map<number, Countdown>();

  success(message: string, options?: ToastOptions | string): void {
    this.show('success', message, options);
  }

  info(message: string, options?: ToastOptions | string): void {
    this.show('info', message, options);
  }

  error(message: string, options?: ToastOptions | string): void {
    this.show('error', message, options);
  }

  /** Ferme un toast avant l'heure (croix, ou place à faire). */
  dismiss(id: number): void {
    this.stop(id);
    this._toasts.update((list) => list.filter((toast) => toast.id !== id));
  }

  /** Retire le toast portant cette clé, s'il est encore là. */
  dismissKey(key: string): void {
    const found = this._toasts().find((toast) => toast.key === key);
    if (found) {
      this.dismiss(found.id);
    }
  }

  /**
   * Suspend tous les comptes à rebours, le temps de lire.
   *
   * Tous, et pas seulement celui qu'on survole : on déplie la pile pour la
   * lire, et laisser les autres filer pendant qu'on lit le premier reviendrait
   * à retirer le texte des yeux.
   */
  holdAll(): void {
    for (const id of [...this.countdowns.keys()]) {
      this.hold(id);
    }
  }

  /** Relance tous les comptes à rebours là où ils en étaient. */
  releaseAll(): void {
    for (const id of [...this.countdowns.keys()]) {
      this.release(id);
    }
  }

  private hold(id: number): void {
    const countdown = this.countdowns.get(id);
    if (!countdown?.handle) {
      return;
    }
    clearTimeout(countdown.handle);
    countdown.handle = null;
    countdown.remaining = Math.max(0, countdown.remaining - (Date.now() - countdown.startedAt));
  }

  private release(id: number): void {
    const countdown = this.countdowns.get(id);
    if (!countdown || countdown.handle) {
      return;
    }
    countdown.startedAt = Date.now();
    countdown.handle = setTimeout(() => this.dismiss(id), countdown.remaining);
  }

  private show(kind: ToastKind, message: string, options?: ToastOptions | string): void {
    // Le détail seul reste le cas courant : l'accepter en chaîne évite un objet
    // à chaque appel.
    const opts: ToastOptions = typeof options === 'string' ? { detail: options } : (options ?? {});
    const id = this.nextId++;
    const life = opts.sticky ? 0 : (opts.life ?? LIFETIME[kind]);
    const toast: Toast = {
      id,
      kind,
      message,
      detail: opts.detail ?? null,
      title: opts.title ?? null,
      life,
      sticky: opts.sticky ?? false,
      action: opts.action ?? null,
      key: opts.key ?? null,
    };

    this._toasts.update((list) => {
      // Une clé déjà posée se remplace : un état qui change ne doit pas empiler
      // trois annonces du même sujet.
      const kept = toast.key ? list.filter((t) => t.key !== toast.key) : list;
      for (const dropped of list.filter((t) => !kept.includes(t))) {
        this.stop(dropped.id);
      }
      const next = [...kept, toast];
      // Les évincés emportent leur minuterie : sans ça, un compte à rebours
      // sans toast resterait à courir pour rien.
      for (const gone of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) {
        this.stop(gone.id);
      }
      return next.slice(-MAX_VISIBLE);
    });

    if (!toast.sticky) {
      this.countdowns.set(id, {
        handle: setTimeout(() => this.dismiss(id), life),
        remaining: life,
        startedAt: Date.now(),
      });
    }
  }

  private stop(id: number): void {
    const countdown = this.countdowns.get(id);
    if (countdown?.handle) {
      clearTimeout(countdown.handle);
    }
    this.countdowns.delete(id);
  }
}
