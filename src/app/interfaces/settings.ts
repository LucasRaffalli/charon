/** Préférences persistées de l'application. */
export interface Settings {
  showHidden: boolean;
  /** Minutes d'inactivité avant fermeture d'une connexion (0 = jamais). */
  idleMinutes: number;
  /** App d'ouverture pour l'édition distante (vide = défaut système). */
  editorApp: string;
  /** Logo Charon en filigrane de fond quand on est connecté. */
  logoBackground: boolean;
}
