/** Entrée de répertoire telle que sérialisée par le backend Rust. */
export interface FileEntryDto {
  name: string;
  is_dir: boolean;
  size: number;
  /** Permissions POSIX, absentes si le serveur ne les donne pas. */
  mode?: number;
  owner?: string;
  group?: string;
}

/** Entrée de répertoire manipulée par l'application. */
export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** Permissions POSIX (12 bits utiles), absentes si le serveur se tait. */
  mode?: number;
  owner?: string;
  group?: string;
}
