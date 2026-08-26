/** Protocoles de connexion supportés. */
export type RemoteProtocol = 'sftp' | 'ftps' | 'ftp';

import { AuthMethod, ServerEnvironment, ServerProtection } from './profile';

/** Paramètres d'ouverture d'une connexion distante. */
export interface ConnectionParams {
  /** Environnement du serveur (badge PROD pendant la session). */
  environment?: ServerEnvironment | null;
  /** Garde-fou appliqué à la session (confirmation renforcée / lecture seule). */
  protection?: ServerProtection | null;
  /** Défaut : 'sftp'. */
  protocol?: RemoteProtocol;
  host: string;
  port: number;
  user: string;
  password?: string | null;
  keyPath?: string | null;
  keyPassphrase?: string | null;
  /** Si présent, le backend lit la passphrase du profil dans le trousseau
   *  macOS : le secret ne transite jamais par la WebView. */
  profileId?: string | null;
  /** SFTP : 'key' (défaut) ou 'password'. Dit au backend ce qu'est le secret. */
  authMethod?: AuthMethod | null;
}
