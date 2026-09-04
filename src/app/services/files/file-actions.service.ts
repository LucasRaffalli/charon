import { open } from '@tauri-apps/plugin-dialog';
import { Injectable, inject } from '@angular/core';

import { FileEntry } from '@app/interfaces';
import { FileBrowserState } from '@app/services/connection/file-browser-state';
import { LocalFsService } from '@app/services/connection/local-fs.service';
import { SettingsService } from '@app/services/system/settings.service';
import { Session } from '@app/services/connection/session-registry';
import { lineDiff } from '@app/services/files/diff';
import { OverwriteService } from '@app/services/files/overwrite.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { injectT } from '@app/lang/i18n.service';

/** Taille max lue de chaque côté pour l'aperçu de diff (256 Kio). */
const DIFF_MAX_BYTES = 256 * 1024;

/** Nom d'entrée valide : pas de séparateur, pas de `.` / `..`. */
// Les caractères de contrôle sont refusés avec les séparateurs : ils n'ont
// aucun usage dans un nom de fichier, et un CRLF collé dans le champ partirait
// tel quel dans le canal de contrôle FTP. Le backend pose
// la même garde, celle-ci sert à le dire avant d'essayer.
export const isValidEntryName = (name: string): boolean =>
  // eslint-disable-next-line no-control-regex
  !/[/\\]/.test(name) && !/[\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..';

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
  private readonly settings = inject(SettingsService);
  private readonly t = injectT();

  async renameEntry(browser: FileBrowserState, entry: FileEntry): Promise<void> {
    const name = (
      await this.dialog.prompt({
        title: this.t('files.rename.title', { name: entry.name }),
        value: entry.name,
        confirmLabel: this.t('common.buttons.rename'),
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
        title: this.t('files.delete.guarded.title', { name: entry.name }),
        message:
          this.t(entry.isDir ? 'files.delete.guarded.dirLead' : 'files.delete.guarded.fileLead') +
          this.t('files.delete.guarded.type', { host: confirmHost }),
        placeholder: confirmHost,
        confirmLabel: this.t('common.buttons.delete'),
        danger: true,
      });
      if (typed?.trim() === confirmHost) {
        await browser.remove(entry);
      }
      return;
    }

    if (!entry.isDir) {
      const confirmed = await this.dialog.confirm({
        title: this.t('files.delete.file.title', { name: entry.name }),
        message: this.t('files.delete.definitive'),
        confirmLabel: this.t('common.buttons.delete'),
        danger: true,
      });
      if (confirmed) {
        await browser.remove(entry);
      }
      return;
    }

    // Suppression récursive : confirmation renforcée, taper le nom du dossier.
    const typed = await this.dialog.prompt({
      title: this.t('files.delete.dir.title', { name: entry.name }),
      message: this.t('files.delete.dir.message', { name: entry.name }),
      placeholder: entry.name,
      confirmLabel: this.t('common.buttons.deleteAll'),
      danger: true,
    });
    if (typed?.trim() === entry.name) {
      await browser.remove(entry);
    }
  }

  async createDirIn(browser: FileBrowserState, title: string): Promise<void> {
    const name = (
      await this.dialog.prompt({
        title,
        placeholder: this.t('files.create.dirPlaceholder'),
        confirmLabel: this.t('common.buttons.create'),
      })
    )?.trim();
    if (name && isValidEntryName(name)) {
      await browser.mkdir(name);
    }
  }

  async createFileIn(browser: FileBrowserState, title: string): Promise<void> {
    const name = (
      await this.dialog.prompt({
        title,
        message: this.t('files.create.fileHint'),
        placeholder: this.t('files.create.filePlaceholder'),
        confirmLabel: this.t('common.buttons.create'),
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

  /**
   * Supprime la sélection d'un navigateur, avec la confirmation du lot.
   *
   * Prend un `FileBrowserState` et non une session : le panneau local a la
   * même sélection et les mêmes garde-fous, seul le nom d'hôte à retaper est
   * propre au serveur protégé.
   */
  async deleteSelection(browser: FileBrowserState, confirmHost?: string | null): Promise<void> {
    const entries = browser.selectedEntries();
    if (!entries.length) {
      return;
    }
    if (entries.length === 1) {
      await this.deleteEntry(browser, entries[0], confirmHost);
      browser.clearSelection();
      return;
    }

    const dirs = entries.filter((entry) => entry.isDir).length;
    const detail = dirs
      ? this.t('files.delete.batch.detailDirs', { count: entries.length, dirs })
      : this.t('files.delete.batch.detailFiles', { count: entries.length });

    // Serveur protégé : le nom d'hôte, comme pour une suppression unitaire.
    if (confirmHost) {
      const typed = await this.dialog.prompt({
        title: this.t('files.delete.batch.guardedTitle', { count: entries.length }),
        message: this.t('files.delete.batch.guardedMessage', { detail, host: confirmHost }),
        placeholder: confirmHost,
        confirmLabel: this.t('common.buttons.delete'),
        danger: true,
      });
      if (typed?.trim() !== confirmHost) {
        return;
      }
    } else if (dirs > 0) {
      // Un dossier seul exige de retaper son nom : un lot QUI EN CONTIENT ne
      // doit pas être plus facile à supprimer. Mais un lot n'a pas de nom
      // unique à retaper, et taper un mot pour un lot est plus lourd que la
      // situation ne l'exige : une case à cocher explicite suffit, un geste
      // délibéré sans demander de saisie.
      const acknowledged = await this.dialog.confirm({
        title: this.t('files.delete.batch.dirsTitle', { count: entries.length, dirs }),
        message: this.t('files.delete.batch.dirsMessage', { detail }),
        acknowledge: this.t('files.delete.batch.dirsAcknowledge', { count: entries.length }),
        confirmLabel: this.t('common.buttons.deleteAll'),
        danger: true,
      });
      if (!acknowledged) {
        return;
      }
    } else if (
      !(await this.dialog.confirm({
        title: this.t('files.delete.batch.filesTitle', { count: entries.length }),
        message: this.t('files.delete.batch.filesMessage', { detail }),
        confirmLabel: this.t('common.buttons.delete'),
        danger: true,
      }))
    ) {
      return;
    }

    for (const entry of entries) {
      await browser.removeSilently(browser.pathTo(entry.name), entry.isDir);
    }
    browser.clearSelection();
    await browser.refresh();
  }

  /**
   * Le dossier d'arrivée d'un téléchargement : celui du panneau local (le
   * contrat du double panneau), sauf si le réglage « toujours demander »
   * est posé ou que le geste est explicitement « Télécharger vers… », le
   * Finder tranche alors, pré-ouvert sur le dossier local courant.
   *
   * Rend `null` si l'utilisateur annule le sélecteur : annuler le choix du
   * dossier annule le téléchargement, pas de repli silencieux ailleurs.
   */
  private async resolveDownloadDir(ask: boolean): Promise<string | null> {
    if (!ask && !this.settings.askDownloadDir()) {
      return this.localFs.currentPath();
    }
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: this.localFs.currentPath(),
    });
    return typeof picked === 'string' ? picked : null;
  }

  /** Télécharge un fichier du serveur ; `ask` force le choix du dossier. */
  async download(session: Session, entry: FileEntry, ask = false): Promise<void> {
    const dir = await this.resolveDownloadDir(ask);
    if (dir === null) {
      return;
    }
    const done = await session.transfers.download(
      session.sftp.pathTo(entry.name),
      joinLocal(dir, entry.name),
      entry.name,
    );
    if (done && dir === this.localFs.currentPath()) {
      await this.localFs.refresh();
    }
  }

  /** Télécharge tout ce qui est sélectionné, fichier par fichier. */
  async downloadSelection(session: Session, ask = false): Promise<void> {
    const dir = await this.resolveDownloadDir(ask);
    if (dir === null) {
      return;
    }
    // Un instantané : la liste bouge sous nos pieds au fil des refresh.
    const files = session.sftp.selectedEntries().filter((entry) => !entry.isDir);
    for (const entry of files) {
      await session.transfers.download(
        session.sftp.pathTo(entry.name),
        joinLocal(dir, entry.name),
        entry.name,
      );
    }
    if (dir === this.localFs.currentPath()) {
      await this.localFs.refresh();
    }
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
      () => this.toasts.success(this.t('common.toasts.pathCopied'), path),
      () => this.toasts.error(this.t('common.errors.clipboard')),
    );
  }
}

/** Un chemin local sous un dossier, sans doubler la barre à la racine. */
function joinLocal(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}
