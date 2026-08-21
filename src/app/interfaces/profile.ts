/** Profil de serveur enregistré. Le secret associé vit dans le trousseau macOS. */
export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath?: string | null;
  hasSecret: boolean;
}
