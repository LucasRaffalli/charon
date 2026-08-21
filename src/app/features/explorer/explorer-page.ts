import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Alert } from '@app/components/alert/alert';
import { Button } from '@app/components/button/button';
import { FilePane } from '@app/components/file-pane/file-pane';
import { Icon } from '@app/components/icon/icon';
import { ResizeHandle } from '@app/components/resize-handle/resize-handle';
import { ThemeSwitcher } from '@app/components/theme-switcher/theme-switcher';
import { FileEntry } from '@app/interfaces';
import { FileSizePipe } from '@app/pipes/file-size-pipe';
import { ContextMenuItem, ContextMenuService } from '@app/services/context-menu.service';
import { DialogService } from '@app/services/dialog.service';
import { FileBrowserState } from '@app/services/file-browser-state';
import { LocalFsService } from '@app/services/local-fs.service';
import { SettingsService } from '@app/services/settings.service';
import { SftpService } from '@app/services/sftp.service';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Nom d'entrée valide : pas de séparateur, pas de `.` / `..`. */
const isValidEntryName = (name: string): boolean =>
  !/[/\\]/.test(name) && name !== '.' && name !== '..';

@Component({
  selector: 'app-explorer-page',
  imports: [Alert, Button, FilePane, Icon, ResizeHandle, ThemeSwitcher, FileSizePipe],
  templateUrl: './explorer-page.html',
  styleUrl: './explorer-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExplorerPage {
  protected readonly sftp = inject(SftpService);
  protected readonly localFs = inject(LocalFsService);
  protected readonly settings = inject(SettingsService);
  protected readonly contextMenu = inject(ContextMenuService);
  private readonly dialog = inject(DialogService);

  protected readonly bento = computed(() => this.settings.layout() === 'bento');
  protected readonly localEntries = computed(() => this.withoutHidden(this.localFs.entries()));
  protected readonly serverEntries = computed(() => this.withoutHidden(this.sftp.entries()));

  private sidebarStartWidth = 0;
  private paneStartHeight = 0;

  constructor() {
    void this.localFs.init();
  }

  protected open(entry: FileEntry): void {
    if (entry.isDir) {
      void this.sftp.openDir(entry.name);
    }
  }

  protected openLocalDir(entry: FileEntry): void {
    void this.localFs.openDir(entry.name);
  }

  protected openServerDir(entry: FileEntry): void {
    void this.sftp.openDir(entry.name);
  }

  /** Envoie un fichier local vers le dossier serveur courant. */
  protected async upload(entry: FileEntry): Promise<void> {
    const written = await this.sftp.upload(
      this.localFs.pathTo(entry.name),
      this.sftp.pathTo(entry.name),
    );
    if (written !== undefined) {
      await this.sftp.refresh();
    }
  }

  /** Télécharge un fichier du serveur vers le dossier local courant. */
  protected async download(entry: FileEntry): Promise<void> {
    const written = await this.sftp.download(
      this.sftp.pathTo(entry.name),
      this.localFs.pathTo(entry.name),
    );
    if (written !== undefined) {
      await this.localFs.refresh();
    }
  }

  // --- Menus contextuels ---

  protected openServerEntryMenu(event: MouseEvent, entry: FileEntry): void {
    const first: ContextMenuItem = entry.isDir
      ? { label: 'Ouvrir', icon: 'folder', action: () => void this.sftp.openDir(entry.name) }
      : { label: 'Télécharger', icon: 'download', action: () => void this.download(entry) };
    this.contextMenu.open(event, [first, ...this.entryActions(this.sftp, entry)]);
  }

  protected openServerAreaMenu(event: MouseEvent): void {
    this.contextMenu.open(event, this.areaActions(this.sftp, 'Nouveau dossier sur le serveur'));
  }

  protected openLocalEntryMenu(event: MouseEvent, entry: FileEntry): void {
    const first: ContextMenuItem = entry.isDir
      ? { label: 'Ouvrir', icon: 'folder', action: () => void this.localFs.openDir(entry.name) }
      : { label: 'Envoyer vers le serveur', icon: 'upload', action: () => void this.upload(entry) };
    this.contextMenu.open(event, [first, ...this.entryActions(this.localFs, entry)]);
  }

  protected openLocalAreaMenu(event: MouseEvent): void {
    this.contextMenu.open(event, this.areaActions(this.localFs, 'Nouveau dossier local'));
  }

  private entryActions(browser: FileBrowserState, entry: FileEntry): ContextMenuItem[] {
    return [
      { label: 'Renommer…', icon: 'pencil', action: () => void this.renameEntry(browser, entry) },
      {
        label: 'Supprimer',
        icon: 'trash',
        danger: true,
        action: () => void this.deleteEntry(browser, entry),
      },
    ];
  }

  private areaActions(browser: FileBrowserState, createTitle: string): ContextMenuItem[] {
    return [
      {
        label: 'Nouveau dossier…',
        icon: 'folder-plus',
        action: () => void this.createDirIn(browser, createTitle),
      },
      { label: 'Actualiser', icon: 'refresh', action: () => void browser.refresh() },
    ];
  }

  private async renameEntry(browser: FileBrowserState, entry: FileEntry): Promise<void> {
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

  private async deleteEntry(browser: FileBrowserState, entry: FileEntry): Promise<void> {
    const confirmed = await this.dialog.confirm({
      title: `Supprimer « ${entry.name} » ?`,
      message: entry.isDir ? 'Seul un dossier vide peut être supprimé.' : 'Cette action est définitive.',
      confirmLabel: 'Supprimer',
      danger: true,
    });
    if (confirmed) {
      await browser.remove(entry);
    }
  }

  private async createDirIn(browser: FileBrowserState, title: string): Promise<void> {
    const name = (
      await this.dialog.prompt({ title, placeholder: 'nom-du-dossier', confirmLabel: 'Créer' })
    )?.trim();
    if (name && isValidEntryName(name)) {
      await browser.mkdir(name);
    }
  }

  // --- Redimensionnement ---

  protected beginSidebarResize(): void {
    this.sidebarStartWidth = this.settings.sidebarWidth();
  }

  protected resizeSidebar(delta: number): void {
    this.settings.update({ sidebarWidth: clamp(this.sidebarStartWidth + delta, 200, 480) });
  }

  protected beginPaneResize(): void {
    this.paneStartHeight = this.settings.localPaneHeight();
  }

  protected resizePane(delta: number): void {
    this.settings.update({ localPaneHeight: clamp(this.paneStartHeight + delta, 140, 700) });
  }

  private withoutHidden(entries: FileEntry[]): FileEntry[] {
    return this.settings.showHidden()
      ? entries
      : entries.filter((entry) => !entry.name.startsWith('.'));
  }
}
