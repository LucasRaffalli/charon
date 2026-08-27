import { computed, signal } from '@angular/core';

import { FileEntry, FileEntryDto, PathSegment } from '@app/interfaces';

/**
 * Socle commun aux navigateurs de fichiers (disque local, SFTP) :
 * état réactif, navigation et gestion centralisée des erreurs.
 */
export abstract class FileBrowserState {
  protected readonly _currentPath = signal('/');
  protected readonly _entries = signal<FileEntry[]>([]);
  protected readonly _loading = signal(false);
  protected readonly _error = signal<string | null>(null);

  readonly currentPath = this._currentPath.asReadonly();
  readonly entries = this._entries.asReadonly();

  /**
   * Filtre du listing (portée A de docs/search.md) : réduit la liste affichée,
   * sans réseau. Écrit directement par les champs de filtre des panneaux.
   */
  readonly filter = signal('');
  /** Filtre par nature, en complément du texte. */
  readonly kindFilter = signal<'all' | 'dirs' | 'files'>('all');

  /**
   * Les entrées vues à travers le filtre. Les consommateurs qui veulent le
   * dossier entier (palette, transferts) gardent `entries`.
   */
  readonly filteredEntries = computed<FileEntry[]>(() => {
    const needle = this.filter().trim().toLowerCase();
    const kind = this.kindFilter();
    let list = this._entries();
    if (kind !== 'all') {
      list = list.filter((entry) => entry.isDir === (kind === 'dirs'));
    }
    if (needle) {
      // Le tri dossiers d'abord vient du backend : filtrer préserve l'ordre.
      list = list.filter((entry) => entry.name.toLowerCase().includes(needle));
    }
    return list;
  });
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  readonly atRoot = computed(() => this._currentPath() === '/');
  readonly breadcrumb = computed<PathSegment[]>(() => {
    const segments = this._currentPath().split('/').filter(Boolean);
    return segments.map((name, index) => ({
      name,
      path: `/${segments.slice(0, index + 1).join('/')}`,
    }));
  });

  /** Récupère le contenu brut d'un dossier. */
  protected abstract fetchEntries(path: string): Promise<FileEntryDto[]>;

  protected abstract createDir(path: string): Promise<void>;
  protected abstract createFile(path: string): Promise<void>;
  protected abstract removeEntry(path: string, isDir: boolean): Promise<void>;
  protected abstract renameEntry(from: string, to: string): Promise<void>;

  async listDir(path: string): Promise<boolean> {
    const entries = await this.run(() => this.fetchEntries(path));
    if (entries === undefined) {
      return false;
    }

    // Changer de dossier vide le filtre : il décrivait l'ancien contenu. Un
    // refresh (même chemin) le garde, on est toujours au même endroit.
    if (path !== this._currentPath()) {
      this.filter.set('');
      this.kindFilter.set('all');
    }
    this._entries.set(entries.map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size })));
    this._currentPath.set(path);
    return true;
  }

  openDir(name: string): Promise<boolean> {
    return this.listDir(this.pathTo(name));
  }

  navigateUp(): Promise<boolean> {
    const segments = this._currentPath().split('/').filter(Boolean);
    segments.pop();
    return this.listDir(`/${segments.join('/')}`);
  }

  refresh(): Promise<boolean> {
    return this.listDir(this._currentPath());
  }

  async mkdir(name: string): Promise<boolean> {
    if (!(await this.runVoid(() => this.createDir(this.pathTo(name))))) {
      return false;
    }
    return this.refresh();
  }

  async mkfile(name: string): Promise<boolean> {
    if (!(await this.runVoid(() => this.createFile(this.pathTo(name))))) {
      return false;
    }
    return this.refresh();
  }

  async remove(entry: FileEntry): Promise<boolean> {
    if (!(await this.runVoid(() => this.removeEntry(this.pathTo(entry.name), entry.isDir)))) {
      return false;
    }
    return this.refresh();
  }

  async rename(entry: FileEntry, newName: string): Promise<boolean> {
    if (!(await this.runVoid(() => this.renameEntry(this.pathTo(entry.name), this.pathTo(newName))))) {
      return false;
    }
    return this.refresh();
  }

  /** Chemin absolu d'une entrée du dossier courant. */
  pathTo(name: string): string {
    const base = this._currentPath();
    return base === '/' ? `/${name}` : `${base}/${name}`;
  }

  /** Comme `run`, pour les opérations sans valeur de retour : true = succès. */
  protected async runVoid(operation: () => Promise<unknown>): Promise<boolean> {
    return (
      (await this.run(async () => {
        await operation();
        return true;
      })) ?? false
    );
  }

  /** Exécute une opération en gérant loading et error de façon centralisée. */
  protected async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    this._loading.set(true);
    this._error.set(null);
    try {
      return await operation();
    } catch (error) {
      this._error.set(this.toMessage(error));
      return undefined;
    } finally {
      this._loading.set(false);
    }
  }

  private toMessage(error: unknown): string {
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
