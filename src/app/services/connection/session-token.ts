import { InjectionToken } from '@angular/core';

/**
 * L'identité de la session dans laquelle un service d'état vit (`s1`, `s2`…).
 *
 * Fournie par l'injecteur de chaque session. Dans son propre fichier pour que
 * les services d'état puissent la connaître sans importer le registre, qui
 * les importe déjà : un cycle de modules n'attend que ça.
 */
export const SESSION_ID = new InjectionToken<string>('charon-session-id');
