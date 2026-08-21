/** Entrée de répertoire telle que sérialisée par le backend Rust. */
export interface FileEntryDto {
  name: string;
  is_dir: boolean;
  size: number;
}

/** Entrée de répertoire manipulée par l'application. */
export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
}
