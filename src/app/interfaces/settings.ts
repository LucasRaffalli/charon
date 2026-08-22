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
  /** Panneau inférieur déplié ? */
  bottomPanelOpen: boolean;
  /** Onglet actif du panneau inférieur. */
  bottomPanelTab: string;
  /** App d'ouverture pour l'édition distante (vide = défaut système). */
  editorApp: string;
  /** Logo Charon en filigrane de fond quand on est connecté. */
  logoBackground: boolean;
}
