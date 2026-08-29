import { Injectable, inject } from '@angular/core';

import { FileEntry } from '@app/interfaces';
import { FileBrowserState } from '@app/services/connection/file-browser-state';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { Session } from '@app/services/connection/session-registry';
import { lineDiff } from '@app/services/files/diff';
import { OverwriteService } from '@app/services/files/overwrite.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { ToastService } from '@app/services/workspace/toast.service';

/** Taille max lue de chaque côté pour l'aperçu de diff (256 Kio). */
const DIFF_MAX_BYTES = 256 * 1024;

/** Nom d'entrée valide : pas de séparateur, pas de `.` / `..`. */
export const isValidEntryName = (name: string): boolean =>
  !/[/\\]/.test(name) && name !== '.' && name !== '..';

/**
 * Un fichier créé sans extension en reçoit une : `.txt`.
 *
 * Le point compte, pas sa position : `.env` et `.gitignore` ont bien un point
 * et restent tels quels : ce sont des fichiers cachés, pas des fichiers sans
 * extension. Un nom vraiment nu (`notes`, `Dockerfile`) devient `notes.txt`,
 * et c'est annoncé dans le dialogue pour que personne ne soit surpris.
 */
export function withDefaultExtension(name: string): string {
  return name.includes('.') ? name : `${name}.txt`;
}

/**
 * Les gestes de fichiers qui parlent à l'utilisateur : renommer, supprimer,
 * créer, télécharger, envoyer avec garde d'écrasement.
 *
 * En service et non dans un composant, parce qu'ils servent DEUX panneaux
 * (local et serveur), N sessions (chaque panneau serveur passe la sienne), et
 * les raccourcis clavier qui routent vers la session focalisée. Les dialogues
 * et leurs garde-fous n'existent qu'une fois.
 */
@Injectable({ providedIn: 'root' })
export class FileActionsService {
  private readonly dialog = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly overwrite = inject(OverwriteService);
  private readonly localFs = inject(LocalFsService);

  async renameEntry(browser: FileBrowserState, entry: FileEntry): Promise<void> {
    const name = (
      await this.dialog.prompt({
        title: `Renommer « ${entry.name} »`,
        value: entry.name,
        confirmLabel: 'Renommer',
      })
    )?.trim();
    if (name && name !== entry.name && isValidEntryName(name)) {
      await browser.rename(entry, name);
    }
  }

  /**
   * Supprime une entrée, avec le garde-fou proportionné : `confirmHost` posé
   * (serveur protégé « confirmation ») exige le nom d'hôte ; un dossier exige
   * son nom ; un fichier, une confirmation simple.
   */
  async deleteEntry(
    browser: FileBrowserState,
    entry: FileEntry,
    confirmHost?: string | null,
  ): Promise<void> {
    if (confirmHost) {
      const typed = await this.dialog.prompt({
        title: `Serveur protégé : supprimer « ${entry.name} » ?`,
        message:
          (entry.isDir
            ? 'Le dossier et tout son contenu seront supprimés définitivement. '
            : 'Cette action est définitive. ') + `Tape « ${confirmHost} » pour confirmer.`,
        placeholder: confirmHost,
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (typed?.trim() === confirmHost) {
        await browser.remove(entry);
      }
      return;
    }

    if (!entry.isDir) {
      const confirmed = await this.dialog.confirm({
        title: `Supprimer « ${entry.name} » ?`,
        message: 'Cette action est définitive.',
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (confirmed) {
        await browser.remove(entry);
      }
      return;
    }

    // Suppression récursive : confirmation renforcée, taper le nom du dossier.
    const typed = await this.dialog.prompt({
      title: `Supprimer « ${entry.name} » et tout son contenu ?`,
      message:
        `Le dossier et tout ce qu'il contient seront supprimés définitivement. ` +
        `Tape « ${entry.name} » pour confirmer.`,
      placeholder: entry.name,
      confirmLabel: 'Tout supprimer',
      danger: true,
    });
    if (typed?.trim() === entry.name) {
      await browser.remove(entry);
    }
  }

  async createDirIn(browser: FileBrowserState, title: string): Promise<void> {
    const name = (
      await this.dialog.prompt({ title, placeholder: 'nom-du-dossier', confirmLabel: 'Créer' })
    )?.trim();
    if (name && isValidEntryName(name)) {
      await browser.mkdir(name);
    }
  }

  async createFileIn(browser: FileBrowserState, title: string): Promise<void> {
    const name = (
      await this.dialog.prompt({
        title,
        message: 'Sans extension, le fichier sera créé en .txt.',
        placeholder: 'nom-du-fichier.txt',
        confirmLabel: 'Créer',
      })
    )?.trim();
    if (name && isValidEntryName(name)) {
      await browser.mkfile(withDefaultExtension(name));
    }
  }

  /**
   * Met une sélection à la corbeille (idée 02). Sans confirmation, à dessein :
   * c'est tout l'intérêt du filet, et le toast porte l'annulation.
   */
  async trashSelection(session: Session, entries: FileEntry[]): Promise<void> {
    if (await session.trash.trash(entries)) {
      session.sftp.clearSelection();
    }
  }

  /** Supprime la sélection d'une session, avec la confirmation du lot. */
  async deleteSelection(session: Session): Promise<void> {
    const sftp = session.sftp;
    const entries = sftp.selectedEntries();
    if (!entries.length) {
      return;
    }
    if (entries.length === 1) {
      await this.deleteEntry(sftp, entries[0], sftp.protection() === 'confirm' ? sftp.host() : null);
      sftp.clearSelection();
      return;
    }

    const dirs = entries.filter((entry) => entry.isDir).length;
    const detail = dirs
      ? `${entries.length} éléments, dont ${dirs} dossier${dirs > 1 ? 's' : ''} et tout leur contenu.`
      : `${entries.length} fichiers.`;

    // Serveur protégé : le nom d'hôte, comme pour une suppression unitaire.
    if (sftp.protection() === 'confirm') {
      const host = sftp.host();
      const typed = await this.dialog.prompt({
        title: `Serveur protégé : supprimer ${entries.length} éléments ?`,
        message: `${detail} Tape « ${host} » pour confirmer.`,
        placeholder: host,
        confirmLabel: 'Supprimer',
        danger: true,
      });
      if (typed?.trim() !== host) {
        return;
      }
    } else if (dirs > 0) {
      // Un dossier seul exige de retaper son nom : un lot QUI EN CONTIENT ne
      // doit pas être plus facile à supprimer. Le lot n'a pas de nom unique,
      // d'où le mot à taper.
      const typed = await this.dialog.prompt({
        title: `Supprimer ${entries.length} éléments, dont ${dirs} dossier${dirs > 1 ? 's' : ''} ?`,
        message: `${detail} Tape « supprimer » pour confirmer.`,
        placeholder: 'supprimer',
        confirmLabel: 'Tout supprimer',
        danger: true,
      });
      if (typed?.trim().toLowerCase() !== 'supprimer') {
        return;
      }
    } else if (
      !(await this.dialog.confirm({
        title: `Supprimer ${entries.length} fichiers ?`,
        message: `${detail} Cette action est définitive.`,
        confirmLabel: 'Supprimer',
        danger: true,
      }))
    ) {
      return;
    }

    for (const entry of entries) {
      await sftp.removeSilently(sftp.pathTo(entry.name), entry.isDir);
    }
    sftp.clearSelection();
    await sftp.refresh();
  }

  /** Télécharge un fichier du serveur vers le dossier local courant. */
  async download(session: Session, entry: FileEntry): Promise<void> {
    const done = await session.transfers.download(
      session.sftp.pathTo(entry.name),
      this.localFs.pathTo(entry.name),
      entry.name,
    );
    if (done) {
      await this.localFs.refresh();
    }
  }

  /** Télécharge tout ce qui est sélectionné, fichier par fichier. */
  async downloadSelection(session: Session): Promise<void> {
    // Un instantané : la liste bouge sous nos pieds au fil des refresh.
    const files = session.sftp.selectedEntries().filter((entry) => !entry.isDir);
    for (const entry of files) {
      await session.transfers.download(
        session.sftp.pathTo(entry.name),
        this.localFs.pathTo(entry.name),
        entry.name,
      );
    }
    await this.localFs.refresh();
  }

  /**
   * Upload avec garde d'écrasement : si la cible existe déjà (SFTP), propose
   * un aperçu de diff et alerte si la version serveur est plus récente
   * (détection de conflit). Renvoie true si le transfert a abouti.
   */
  async uploadWithGuard(
    session: Session,
    localPath: string,
    remotePath: string,
    name: string,
  ): Promise<boolean> {
    const sftp = session.sftp;
    if (sftp.protocol() === 'sftp' && sftp.protection() !== 'readonly') {
      const remote = await sftp.stat(remotePath);
      if (remote?.exists && !remote.isDir) {
        const local = (await this.localFs.stat(localPath)) ?? {
          exists: true,
          isDir: false,
          size: 0,
          mtime: 0,
        };
        const remoteNewer = remote.mtime > 0 && local.mtime > 0 && remote.mtime > local.mtime;
        const decision = await this.overwrite.request({
          name,
          remoteNewer,
          local,
          remote,
          loadDiff: async () => {
            const [remoteText, localText] = await Promise.all([
              sftp.readText(remotePath, DIFF_MAX_BYTES),
              this.localFs.readText(localPath, DIFF_MAX_BYTES),
            ]);
            if (remoteText === undefined || localText === undefined) {
              return null;
            }
            if (remoteText.includes('\u0000') || localText.includes('\u0000')) {
              return null; // binaire
            }
            return lineDiff(remoteText, localText);
          },
        });
        if (decision !== 'overwrite') {
          return false;
        }
      }
    }
    return session.transfers.upload(localPath, remotePath, name);
  }

  /**
   * Copie un chemin dans le presse-papier système. Le geste ne laisse aucune
   * trace à l'écran : sans un mot, rien ne distingue une copie réussie d'un
   * clic qui a raté sa cible.
   */
  copyPath(path: string): void {
    void navigator.clipboard.writeText(path).then(
      () => this.toasts.success('Chemin copié', path),
      () => this.toasts.error("Le presse-papier n'est pas accessible"),
    );
  }
}
