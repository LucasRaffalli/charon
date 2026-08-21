/** Protocoles de connexion supportés. */
export type RemoteProtocol = 'sftp' | 'ftps' | 'ftp';

/** Paramètres d'ouverture d'une connexion distante. */
export interface ConnectionParams {
  /** Défaut : 'sftp'. */
  protocol?: RemoteProtocol;
  host: string;
  port: number;
  user: string;
  password?: string | null;
  keyPath?: string | null;
  keyPassphrase?: string | null;
  /** Si présent, le backend lit la passphrase du profil dans le trousseau
   *  macOS — le secret ne transite jamais par la WebView. */
  profileId?: string | null;
}
