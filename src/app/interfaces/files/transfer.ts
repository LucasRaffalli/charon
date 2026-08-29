/** Payload de l'event Tauri `transfer:progress` émis par le backend. */
export interface TransferProgressEvent {
  id: string;
  transferred: number;
  total: number;
}

/** `remote` = le pont : d'un serveur à un autre, sans toucher le disque local. */
export type TransferDirection = 'download' | 'upload' | 'remote';

export type TransferStatus = 'active' | 'done' | 'error' | 'cancelled' | 'interrupted';

/** Un transfert suivi par la file (streaming côté Rust, persisté pour la reprise). */
/**
 * Où en est la vérification d'intégrité (idée 04) : les empreintes sha256
 * locale et distante ont-elles été comparées, et que disent-elles ?
 */
export type VerifyState = 'checking' | 'ok' | 'mismatch' | 'skipped' | 'error';

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
  /** Epoch ms du départ : sert au calcul du débit. */
  startedAt?: number;
  /** Débit moyen en octets par seconde, 0 tant qu'il est inconnu. */
  speed?: number;
  /** Vérification d'intégrité, absente si elle n'a pas été demandée. */
  verify?: VerifyState;
  /** Ce qui a empêché la vérification, quand `verify` vaut error ou skipped. */
  verifyDetail?: string;
  /** La route d'un pont : « vps-prod → backup ». Sans elle, deux fenêtres
   *  ouvertes ne sauraient pas qui envoie quoi où. */
  route?: string;
}
