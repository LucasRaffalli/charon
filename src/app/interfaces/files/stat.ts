/** Métadonnées d'un fichier (local ou distant) : détection de conflit. */
export interface StatInfo {
  exists: boolean;
  isDir: boolean;
  size: number;
  /** Date de modification (epoch secondes) ; 0 si inconnue. */
  mtime: number;
}
