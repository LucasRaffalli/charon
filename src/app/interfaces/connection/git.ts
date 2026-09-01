/** Un fichier que Git signale, tel que `git status --porcelain` le donne. */
export interface GitFile {
  /** Chemin relatif à la racine du dépôt. */
  path: string;
  /** Les deux lettres de git (` M`, `A `, `??`, `UU`…), telles quelles. */
  code: string;
  kind: 'staged' | 'modified' | 'untracked' | 'conflicted';
}

/** L'état du dépôt qui contient le dossier affiché. */
export interface GitStatus {
  root: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  lastCommit: string;
  /** Dépôt initialisé mais sans le moindre commit. */
  unborn: boolean;
  files: GitFile[];
}
