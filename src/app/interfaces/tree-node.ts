/** Un nœud de l'arborescence serveur (dossiers ET fichiers, chargement paresseux). */
export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  expanded: boolean;
  loading: boolean;
  /** null = enfants pas encore chargés (dossiers uniquement). */
  children: TreeNode[] | null;
}
