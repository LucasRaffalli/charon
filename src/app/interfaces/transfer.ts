/** Payload de l'event Tauri `transfer:progress` émis par le backend. */
export interface TransferProgressEvent {
  id: string;
  transferred: number;
  total: number;
}

export type TransferDirection = 'download' | 'upload';

export type TransferStatus = 'active' | 'done' | 'error' | 'cancelled' | 'interrupted';

/** Un transfert suivi par la file (streaming côté Rust, persisté pour la reprise). */
export interface Transfer {
  id: string;
  name: string;
  direction: TransferDirection;
  transferred: number;
  /** 0 si la taille est inconnue. */
  total: number;
  status: TransferStatus;
  error: string | null;
  /** Connexion d'origine : la reprise exige d'y être reconnecté. */
  connectionId: string;
  remotePath: string;
  localPath: string;
}
