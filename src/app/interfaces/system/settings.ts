/** Préférences persistées de l'application. */
export interface Settings {
  showHidden: boolean;
  /** Minutes d'inactivité avant fermeture d'une connexion (0 = jamais). */
  idleMinutes: number;
  /** App d'ouverture pour l'édition distante (vide = défaut système). */
  editorApp: string;
  /**
   * Comparer les empreintes sha256 après chaque transfert (idée 04). Coûte
   * une lecture complète des deux côtés, d'où le réglage.
   */
  verifyTransfers: boolean;
  /** Formater avec Prettier à l'enregistrement depuis l'aperçu (types couverts). */
  formatOnSave: boolean;
  /**
   * Jours de rétention de la corbeille distante (idée 02), purgée à la
   * connexion. 0 = ne jamais purger.
   */
  trashDays: number;
}
