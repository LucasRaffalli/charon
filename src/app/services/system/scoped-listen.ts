import { DestroyRef, inject } from '@angular/core';
import { EventCallback, listen } from '@tauri-apps/api/event';

/**
 * `listen` Tauri lié à la durée de vie de l'injecteur appelant.
 *
 * Les services de session vivent dans un injecteur d'environnement détruit à
 * la fermeture de l'onglet : un `listen` nu y survivait, closure vivante qui
 * continuait d'écrire dans les signaux d'un service mort (sept écouteurs
 * fuyaient par session ouverte puis fermée). Ici le désabonnement part avec
 * l'injecteur, et un abonnement qui aboutit APRÈS la destruction est coupé
 * immédiatement.
 */
export function injectTauriListen(): <T>(event: string, handler: EventCallback<T>) => void {
  const destroyRef = inject(DestroyRef);
  return (event, handler) => {
    let dead = false;
    let stop: (() => void) | null = null;
    destroyRef.onDestroy(() => {
      dead = true;
      stop?.();
    });
    void listen(event, handler).then((unlisten) => {
      if (dead) {
        unlisten();
      } else {
        stop = unlisten;
      }
    });
  };
}
