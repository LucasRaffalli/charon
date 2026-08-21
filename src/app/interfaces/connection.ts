/** Paramètres d'ouverture d'une connexion SFTP. */
export interface ConnectionParams {
  host: string;
  port: number;
  user: string;
  password?: string | null;
  keyPath?: string | null;
  keyPassphrase?: string | null;
}
