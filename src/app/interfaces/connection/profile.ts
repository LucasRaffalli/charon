import { RemoteProtocol } from './connection';

/** Environnement d'un serveur : pilote la couleur et le badge PROD. */
export type ServerEnvironment = 'dev' | 'staging' | 'prod';

/** Garde-fou d'un serveur : confirmation renforcée ou lecture seule. */
export type ServerProtection = 'confirm' | 'readonly';

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
  /** Environnement (badge PROD, pastilles) ; absent = non renseigné. */
  environment?: ServerEnvironment | null;
  /** Garde-fou ; absent = aucun. */
  protection?: ServerProtection | null;
  /** Ce qu'est le secret au trousseau ; absent sur les anciens profils = 'key'. */
  authMethod?: AuthMethod | null;
  /**
   * Dossier d'arrivée : où la connexion dépose l'explorateur.
   *
   * Absent, on arrive au dossier personnel, puis à la racine. Sur un serveur
   * où l'on travaille toujours au même endroit, retraverser l'arborescence à
   * chaque connexion est une corvée que rien ne justifie.
   */
  anchor?: string | null;
}

/**
 * Authentification SFTP : par clé (le secret est la passphrase de la clé) ou
 * par mot de passe de compte. Le choix est explicite, parce qu'un même champ
 * pour les deux ne dit pas ce qu'on est en train de taper.
 */
export type AuthMethod = 'key' | 'password';
