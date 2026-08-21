/** Style de disposition de l'explorateur. */
export type LayoutMode = 'bento' | 'classic';

/** Préférences persistées de l'application. */
export interface Settings {
  layout: LayoutMode;
  showHidden: boolean;
  sidebarWidth: number;
  localPaneHeight: number;
  /** Minutes d'inactivité avant fermeture d'une connexion (0 = jamais). */
  idleMinutes: number;
}
