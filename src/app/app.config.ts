import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';

import { provideSessionServices } from '@app/services/connection/session-registry';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Zoneless : l'app est 100 % signaux + OnPush, zéro rxjs, zéro async
    // pipe. Avec zone.js, chaque pointermove, chaque setInterval et chaque
    // event Tauri déclenchait un cycle applicatif complet ; ici seuls les
    // signaux notifient. (Le router n'a jamais servi : zéro route, l'app est
    // pilotée par des signaux, pas par l'URL.)
    provideZonelessChangeDetection(),
    // La flotte v2 : les services d'état viennent de la session, pas de la
    // racine. Voir le pont dans session-registry.ts.
    provideSessionServices(),
  ],
};
