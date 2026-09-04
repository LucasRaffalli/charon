import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { FileEntryDto } from '@app/interfaces';
import { FileTree } from '@app/services/connection/sftp-tree.service';
import { LocalFsService } from '@app/services/connection/local-fs.service';

/**
 * L'arborescence du disque local (issue #9) : le même moteur que l'arbre
 * serveur, branché sur le panneau local. Un singleton de fenêtre et non un
 * service de session : le disque est le même quel que soit le serveur.
 *
 * `active` est toujours vrai : le disque, lui, ne se déconnecte pas. Au
 * démarrage l'arbre part de la racine, puis suit `init()` quand le panneau
 * local choisit l'ancre ou le dossier personnel.
 */
@Injectable({ providedIn: 'root' })
export class LocalTreeService extends FileTree {
  constructor() {
    const localFs = inject(LocalFsService);
    super({
      active: () => true,
      currentPath: () => localFs.currentPath(),
      entries: () => localFs.entries(),
      fetchEntries: (path) =>
        invoke<FileEntryDto[]>('local_list_dir', { path }).catch((error) => {
          // La raison est retenue pour s'afficher sur le nœud : sur macOS,
          // un dossier comme Documents ou Bureau peut refuser la lecture
          // tant que l'autorisation système n'a pas été accordée, et un
          // chevron qui se referme sans un mot ne l'explique pas.
          this.noteError(error);
          return null;
        }),
    });
  }
}
