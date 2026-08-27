import { Injectable, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { SettingsService } from '@app/services/system/settings.service';
import { SftpService } from '@app/services/connection/sftp.service';

interface EditEvent {
  id: string;
  message: string;
}

export type EditStatus = 'editing' | 'synced' | 'error';

export interface EditSession {
  id: string;
  name: string;
  remotePath: string;
  status: EditStatus;
  /** Dernière synchronisation réussie (epoch ms), null si aucune. */
  lastSync: number | null;
  error: string | null;
  /** Dernière activité (ouverture / sync / erreur) : pilote l'auto-masquage. */
  lastActivity: number;
}

/**
 * Édition distante : ouvre un fichier serveur dans l'éditeur système et le
 * ré-envoie automatiquement à chaque sauvegarde (surveillance côté Rust).
 * SFTP uniquement.
 */
@Injectable({ providedIn: 'root' })
export class RemoteEditService {
  private readonly sftp = inject(SftpService);
  private readonly activity = inject(ActivityLogService);
  private readonly settings = inject(SettingsService);
  private readonly _sessions = signal<EditSession[]>([]);

  readonly sessions = this._sessions.asReadonly();

  constructor() {
    void listen<EditEvent>('edit:synced', (event) => {
      const now = Date.now();
      this.patch(event.payload.id, { status: 'synced', lastSync: now, lastActivity: now, error: null });
    });
    void listen<EditEvent>('edit:error', (event) => {
      this.patch(event.payload.id, { status: 'error', error: event.payload.message, lastActivity: Date.now() });
      const session = this._sessions().find((s) => s.id === event.payload.id);
      if (session) {
        this.activity.log('edit', 'remote', session.remotePath, event.payload.message, false);
      }
    });
  }

  /** Ouvre un fichier distant dans l'éditeur système (surveillé + re-uploadé). */
  async start(remotePath: string, name: string): Promise<void> {
    if (!this.sftp.connected() || this.sftp.protocol() !== 'sftp') {
      this.sftp.reportError('L’édition distante exige une session SSH (SFTP).');
      return;
    }
    if (this.sftp.protection() === 'readonly') {
      this.sftp.reportError('Serveur en lecture seule : édition refusée.');
      return;
    }
    // Déjà en cours d'édition : ne pas rouvrir une seconde session.
    if (this._sessions().some((s) => s.remotePath === remotePath)) {
      return;
    }
    try {
      const session = await invoke<{ id: string; localPath: string }>('edit_open', {
        connectionId: this.sftp.connectionId(),
        remotePath,
        opener: this.settings.editorApp().trim() || null,
      });
      this._sessions.update((list) => [
        {
          id: session.id,
          name,
          remotePath,
          status: 'editing',
          lastSync: null,
          error: null,
          lastActivity: Date.now(),
        },
        ...list,
      ]);
      this.activity.log('edit', 'remote', remotePath, 'ouvert dans l’éditeur');
    } catch (error) {
      this.sftp.reportError(typeof error === 'string' ? error : String(error));
    }
  }

  /** Arrête la surveillance d'une édition. */
  async stop(id: string): Promise<void> {
    await invoke('edit_stop', { editId: id }).catch(() => undefined);
    this._sessions.update((list) => list.filter((s) => s.id !== id));
  }

  private patch(id: string, changes: Partial<EditSession>): void {
    this._sessions.update((list) =>
      list.map((s) => (s.id === id ? { ...s, ...changes } : s)),
    );
  }
}
