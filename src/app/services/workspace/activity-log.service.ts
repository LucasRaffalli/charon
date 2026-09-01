import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { scopedKey } from '@app/services/system/window-scope';

import { ActivityEntry, ActivityKind } from '@app/interfaces';
import { SESSION_ID } from '@app/services/connection/session-token';

// Par fenêtre : voir scopedKey. Ce qui appartient à une session ne doit
// pas être écrasé par la fenêtre d'à côté.
const STORAGE_KEY = scopedKey('charon:journal');
/** Nombre maximal d'entrées conservées. */
const MAX_ENTRIES = 500;

/** Identités des entrées : monotone sur la vie de la fenêtre. */
let NEXT_ENTRY = 1;

/**
 * Journal d'activité local : chaque opération horodatée (connexions,
 * dossiers, renommages, suppressions, transferts), persistée sur le poste.
 * Rien ne quitte la machine.
 */
/** Une nature d'action et son compte, pour le bilan de session (idée 06). */
export interface SessionTally {
  kind: ActivityKind;
  count: number;
  /** La plus récente des cibles : de quoi situer sans tout lister. */
  sample: string;
}

@Injectable({ providedIn: 'root' })
export class ActivityLogService {
  private readonly _entries = signal<ActivityEntry[]>(this.load());

  readonly entries = this._entries.asReadonly();

  constructor() {
    // Persistance débouncée : 500 entrées re-sérialisées à chaque action,
    // c'était payer un JSON.stringify complet par mkdir ou par renommage.
    effect((onCleanup) => {
      this._entries(); // la dépendance ; la sérialisation attend le calme
      const handle = setTimeout(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(untracked(() => this._entries())));
      }, 300);
      onCleanup(() => clearTimeout(handle));
    });
  }

  log(
    kind: ActivityKind,
    scope: 'remote' | 'local',
    target: string,
    detail: string | null = null,
    ok = true,
    session: string | null = null,
  ): void {
    const entry: ActivityEntry = {
      id: NEXT_ENTRY++,
      at: Date.now(),
      kind,
      scope,
      target,
      detail,
      ok,
      session,
    };
    this._entries.update((list) => [entry, ...list].slice(0, MAX_ENTRIES));
  }

  /**
   * Ce qui a été touché depuis un instant donné, regroupé par nature (idée 06,
   * le bilan de session). Construit sur le journal qui existe déjà : rien à
   * enregistrer de plus, il suffit de regarder en arrière.
   *
   * Les erreurs et les gestes sans conséquence (connexion, ancre) sont
   * écartés : le bilan répond à « qu'est-ce que j'ai changé », pas à « qu'ai-je
   * fait ».
   */
  since(at: number, session: string | null = null): SessionTally[] {
    const counted = new Map<ActivityKind, { count: number; sample: string }>();
    for (const entry of this._entries()) {
      if (entry.at < at || !entry.ok) {
        continue;
      }
      // Le bilan d'une session ne compte que ce qu'elle a fait elle-même :
      // sans ce filtre, débarquer du serveur A raconterait aussi le B.
      if (session && entry.session !== session) {
        continue;
      }
      if (
        entry.kind === 'connect' ||
        entry.kind === 'disconnect' ||
        entry.kind === 'anchor' ||
        entry.kind === 'favorite'
      ) {
        continue;
      }
      const seen = counted.get(entry.kind);
      if (seen) {
        seen.count++;
      } else {
        // Le premier rencontré est le plus récent : c'est celui qu'on montre.
        counted.set(entry.kind, { count: 1, sample: entry.target });
      }
    }
    return [...counted].map(([kind, data]) => ({ kind, ...data }));
  }

  clear(): void {
    this._entries.set([]);
  }

  /** Le journal au format texte (une ligne par entrée), pour copie/export. */
  asText(): string {
    return this._entries()
      .map((entry) => {
        const when = new Date(entry.at).toISOString();
        const state = entry.ok ? 'ok' : 'échec';
        const detail = entry.detail ? ` · ${entry.detail}` : '';
        return `${when}\t${entry.kind}\t${entry.scope}\t${state}\t${entry.target}${detail}`;
      })
      .join('\n');
  }

  private load(): ActivityEntry[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const entries = raw ? (JSON.parse(raw) as ActivityEntry[]) : [];
      // Les entrées d'une session précédente reçoivent une identité neuve.
      return entries.map((entry) => ({ ...entry, id: NEXT_ENTRY++ }));
    } catch {
      return [];
    }
  }
}

/**
 * Le journal vu depuis une session : même instance racine, mais chaque
 * entrée écrite porte l'identité de la session appelante. Les services de
 * session remplacent leur `inject(ActivityLogService)` par ce helper et
 * aucun site d'appel ne change ; hors session (panneau local), le tag
 * reste nul.
 */
export function injectSessionActivity(): { log: ActivityLogService['log'] } {
  const root = inject(ActivityLogService);
  const session = inject(SESSION_ID, { optional: true });
  return {
    log: (kind, scope, target, detail = null, ok = true) =>
      root.log(kind, scope, target, detail, ok, session),
  };
}
