/** Un nœud de l'arborescence serveur (dossiers uniquement, chargement paresseux). */
export interface TreeNode {
  name: string;
  path: string;
  expanded: boolean;
  loading: boolean;
  /** null = sous-dossiers pas encore chargés. */
  children: TreeNode[] | null;
}
