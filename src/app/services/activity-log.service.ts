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

  clear(): void {
    this._entries.set([]);
  }

  /** Le journal au format texte (une ligne par entrée), pour copie/export. */
  asText(): string {
    return this._entries()
      .map((entry) => {
        const when = new Date(entry.at).toISOString();
        const state = entry.ok ? 'ok' : 'échec';
        const detail = entry.detail ? ` — ${entry.detail}` : '';
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
