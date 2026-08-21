import { RemoteProtocol } from './connection';

/** Environnement d'un serveur — pilote la couleur et le badge PROD. */
export type ServerEnvironment = 'dev' | 'staging' | 'prod';

/** Profil de serveur enregistré. Le secret associé vit dans le trousseau macOS. */
export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  keyPath?: string | null;
  hasSecret: boolean;
  /** Absent sur les anciens profils = 'sftp'. */
  protocol?: RemoteProtocol | null;
  /** Environnement (badge PROD, pastilles) — absent = non renseigné. */
  environment?: ServerEnvironment | null;
}
