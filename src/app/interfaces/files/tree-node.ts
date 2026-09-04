/** Un nœud de l'arborescence serveur (dossiers ET fichiers, chargement paresseux). */
export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  expanded: boolean;
  loading: boolean;
  /** null = enfants pas encore chargés (dossiers uniquement). */
  children: TreeNode[] | null;
  /**
   * La dernière lecture de ce dossier a échoué (droits refusés, dossier
   * disparu, autorisation macOS pas encore accordée).
   *
   * Il faut le DIRE : sans ça le nœud se repliait en silence et le clic sur
   * le chevron paraissait sans effet, ce qui ne se diagnostique pas.
   */
  error?: string | null;
}
