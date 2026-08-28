import { Injectable, effect, signal } from '@angular/core';

import { ActivityEntry, ActivityKind } from '@app/interfaces';

const STORAGE_KEY = 'charon:journal';
/** Nombre maximal d'entrées conservées. */
const MAX_ENTRIES = 500;

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
    effect(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._entries()));
    });
  }

  log(
    kind: ActivityKind,
    scope: 'remote' | 'local',
    target: string,
    detail: string | null = null,
    ok = true,
  ): void {
    const entry: ActivityEntry = { at: Date.now(), kind, scope, target, detail, ok };
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
  since(at: number): SessionTally[] {
    const counted = new Map<ActivityKind, { count: number; sample: string }>();
    for (const entry of this._entries()) {
      if (entry.at < at || !entry.ok) {
        continue;
      }
      if (entry.kind === 'connect' || entry.kind === 'disconnect' || entry.kind === 'anchor') {
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
      return raw ? (JSON.parse(raw) as ActivityEntry[]) : [];
    } catch {
      return [];
    }
  }
}
