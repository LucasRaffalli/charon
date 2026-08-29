import { Injectable, inject, signal } from '@angular/core';

import { ActivityKind } from '@app/interfaces';
import { Session } from '@app/services/connection/session-registry';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';

/**
 * La couleur de chaque nature dans le bilan : ce qui a été ajouté en vert, ce
 * qui a été modifié en accent, ce qui a été retiré en ambre. La pastille se
 * lit avant le texte.
 */
const SESSION_TONES: Record<string, RecapLine['tone']> = {
  upload: 'ok',
  download: 'ok',
  mkdir: 'ok',
  edit: 'accent',
  rename: 'accent',
  remove: 'warn',
  cancel: 'warn',
  resume: 'accent',
  module: 'accent',
};

const SESSION_LABELS: Record<string, (n: number) => string> = {
  upload: (n) => `fichier${n > 1 ? 's' : ''} envoyé${n > 1 ? 's' : ''}`,
  download: (n) => `fichier${n > 1 ? 's' : ''} téléchargé${n > 1 ? 's' : ''}`,
  edit: (n) => `fichier${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''}`,
  remove: (n) => `élément${n > 1 ? 's' : ''} supprimé${n > 1 ? 's' : ''}`,
  rename: (n) => `élément${n > 1 ? 's' : ''} renommé${n > 1 ? 's' : ''} ou déplacé${n > 1 ? 's' : ''}`,
  mkdir: (n) => `dossier${n > 1 ? 's' : ''} créé${n > 1 ? 's' : ''}`,
  resume: (n) => `transfert${n > 1 ? 's' : ''} repris`,
  cancel: (n) => `transfert${n > 1 ? 's' : ''} annulé${n > 1 ? 's' : ''}`,
  module: (n) => `action${n > 1 ? 's' : ''} de module`,
};

/** Le chemin raccourci à ses deux derniers segments : la colonne est étroite. */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

/** Une ligne du bilan : ce qui a été fait, combien de fois, et où. */
export interface RecapLine {
  kind: ActivityKind | 'transfer';
  text: string;
  /** La cible la plus récente : de quoi situer sans tout lister. */
  where: string;
  /** Couleur de la pastille : la nature se lit avant le texte. */
  tone: 'ok' | 'accent' | 'warn' | 'err';
}

export interface RecapRequest {
  host: string;
  /** `sftp://user@host`, tel qu'affiché sous le titre. */
  address: string;
  prod: boolean;
  lines: RecapLine[];
}

/**
 * Le bilan de session (idée 06), montré au moment de débarquer.
 *
 * Sous forme de promesse, comme les autres dialogues : l'appelant attend la
 * décision plutôt que de gérer un rappel.
 */
@Injectable({ providedIn: 'root' })
export class SessionRecapService {
  private readonly activity = inject(ActivityLogService);

  private readonly _state = signal<RecapRequest | null>(null);
  private resolver: ((leave: boolean) => void) | null = null;

  readonly state = this._state.asReadonly();

  /**
   * Toute la cérémonie du départ pour UNE session : rien à raconter et rien
   * en vol, on part sans question ; sinon le bilan se montre et rend la
   * décision. Utilisée par ⌘W, le feu rouge et la fermeture d'un onglet.
   */
  async confirmLeave(session: Session): Promise<boolean> {
    const active = session.transfers.activeCount();
    const touched = this.activity.since(session.sftp.connectedAt(), session.id);
    if (!active && !touched.length) {
      return true;
    }

    const lines: RecapLine[] = touched.map((item) => ({
      kind: item.kind,
      text: `${item.count} ${SESSION_LABELS[item.kind](item.count)}`,
      where: shortPath(item.sample),
      tone: SESSION_TONES[item.kind] ?? 'accent',
    }));
    if (active) {
      lines.push({
        kind: 'transfer',
        text: `${active} transfert${active > 1 ? 's' : ''} en cours`,
        where: 'reprise possible',
        tone: 'err',
      });
    }

    return this.ask({
      host: session.sftp.host(),
      address: `${session.sftp.protocol()}://${session.sftp.host()}`,
      prod: session.sftp.environment() === 'prod',
      lines,
    });
  }

  ask(request: RecapRequest): Promise<boolean> {
    this.settle(false);
    this._state.set(request);
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  settle(leave: boolean): void {
    const resolver = this.resolver;
    this.resolver = null;
    this._state.set(null);
    resolver?.(leave);
  }
}
