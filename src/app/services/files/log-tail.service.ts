import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { injectTauriListen } from '@app/services/system/scoped-listen';

import { injectSessionActivity } from '@app/services/workspace/activity-log.service';
import { SftpService } from '@app/services/connection/sftp.service';

interface TailEvent {
  id: string;
  data: string;
}

/** Nombre de lignes d'historique demandées à l'ouverture. */
const INITIAL_LINES = 200;
/** Lignes conservées en mémoire (les plus anciennes sont éjectées). */
const MAX_LINES = 2000;

/** Une ligne du suivi, avec une identité STABLE : la fenêtre glissante
 *  décale tous les index, un `track $index` réécrivait les 2000 lignes du
 *  DOM à chaque paquet reçu. */
export interface TailLine {
  seq: number;
  text: string;
}

/**
 * Suivi de log en direct (`tail -F` sur la session SSH) : un seul fichier
 * suivi à la fois, affiché dans l'onglet Logs du panneau inférieur.
 */
@Injectable({ providedIn: 'root' })
export class LogTailService {
  private readonly tauriListen = injectTauriListen();
  private readonly sftp = inject(SftpService);
  private readonly activity = injectSessionActivity();

  private readonly _path = signal<string | null>(null);
  private nextSeq = 1;
  private readonly _lines = signal<TailLine[]>([]);
  private readonly _running = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly path = this._path.asReadonly();
  readonly lines = this._lines.asReadonly();
  readonly running = this._running.asReadonly();
  readonly error = this._error.asReadonly();

  private tailId: string | null = null;
  /** Décodeur streaming : gère les séquences UTF-8 coupées entre paquets. */
  private decoder = new TextDecoder();
  /** Dernière ligne incomplète en attente de son retour à la ligne. */
  private partial = '';

  constructor() {
    this.tauriListen<TailEvent>('tail:data', (event) => {
      if (event.payload.id !== this.tailId) {
        return;
      }
      const bytes = Uint8Array.from(atob(event.payload.data), (c) => c.charCodeAt(0));
      this.append(this.decoder.decode(bytes, { stream: true }));
    });
    this.tauriListen<TailEvent>('tail:closed', (event) => {
      if (event.payload.id === this.tailId) {
        this._running.set(false);
      }
    });
  }

  /** Suit un fichier distant (remplace le suivi précédent s'il y en a un). */
  async open(remotePath: string): Promise<void> {
    await this.close();

    this._path.set(remotePath);
    this._lines.set([]);
    this._error.set(null);
    this.decoder = new TextDecoder();
    this.partial = '';

    const connectionId = this.sftp.connectionId();
    if (!connectionId || this.sftp.protocol() !== 'sftp') {
      this._error.set('Le suivi de logs exige une session SSH (SFTP).');
      return;
    }

    try {
      this.tailId = await invoke<string>('tail_open', {
        connectionId,
        path: remotePath,
        lines: INITIAL_LINES,
      });
      this._running.set(true);
      this.activity.log('connect', 'remote', remotePath, 'suivi de log');
    } catch (error) {
      this._error.set(typeof error === 'string' ? error : String(error));
    }
  }

  /** Arrête le suivi en cours (le contenu affiché reste). */
  async close(): Promise<void> {
    const id = this.tailId;
    this.tailId = null;
    this._running.set(false);
    if (id) {
      await invoke('tail_close', { tailId: id }).catch(() => undefined);
    }
  }

  /** Oublie le fichier suivi (onglet vide). */
  async clear(): Promise<void> {
    await this.close();
    this._path.set(null);
    this._lines.set([]);
    this._error.set(null);
  }

  private append(chunk: string): void {
    const text = this.partial + chunk;
    const parts = text.split('\n');
    this.partial = parts.pop() ?? '';
    if (parts.length === 0) {
      return;
    }
    this._lines.update((lines) => {
      const stamped = parts.map((text) => ({ seq: this.nextSeq++, text }));
      const merged = [...lines, ...stamped];
      return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged;
    });
  }
}
