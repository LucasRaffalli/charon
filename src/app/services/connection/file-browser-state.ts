import { computed, inject, signal } from '@angular/core';

import { SettingsService } from '@app/services/system/settings.service';
import { injectErrorText } from '@app/lang/i18n.service';

import { FileEntry, FileEntryDto, PathSegment } from '@app/interfaces';

/**
 * Socle commun aux navigateurs de fichiers (disque local, SFTP) :
 * état réactif, navigation et gestion centralisée des erreurs.
 */
export abstract class FileBrowserState {
  protected readonly settings = inject(SettingsService);
  private readonly errorText = injectErrorText();

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
   * Les entrées que l'écran peut montrer : le réglage « fichiers cachés »
   * s'applique ICI et non plus dans chaque panneau. C'est ce qui rend « tout
   * sélectionner » honnête : ⌘A ne doit jamais embarquer des lignes que
   * personne ne voit, sinon le ⌘⌫ qui suit emporte des fichiers cachés.
   */
  readonly shownEntries = computed<FileEntry[]>(() => {
    const list = this._entries();
    return this.settings.showHidden()
      ? list
      : list.filter((entry) => !entry.name.startsWith('.'));
  });

  /**
   * Les entrées vues à travers le filtre. Les consommateurs qui veulent le
   * dossier entier (palette, transferts) gardent `entries`.
   */
  readonly filteredEntries = computed<FileEntry[]>(() => {
    const needle = this.filter().trim().toLowerCase();
    const kind = this.kindFilter();
    let list = this.shownEntries();
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

  // ---------- Sélection (idée 01 de l'artefact des sept idées) ----------

  /**
   * Les noms sélectionnés dans le dossier courant. Des NOMS et pas des index :
   * une entrée renommée ou supprimée pendant une sélection ne doit pas faire
   * pointer la sélection sur sa voisine.
   */
  private readonly _selection = signal<ReadonlySet<string>>(new Set());
  readonly selection = this._selection.asReadonly();

  /**
   * L'ancre du Maj-clic : la ligne depuis laquelle une plage s'étend. Elle
   * survit aux extensions successives (Maj-clic puis Maj-clic plus loin part
   * toujours de la même origine, comme dans un Finder).
   */
  private anchor: string | null = null;

  readonly selectionCount = computed(() => this._selection().size);
  readonly hasSelection = computed(() => this._selection().size > 0);

  /** Les entrées sélectionnées, dans l'ordre d'affichage. */
  readonly selectedEntries = computed<FileEntry[]>(() => {
    const chosen = this._selection();
    return this._entries().filter((entry) => chosen.has(entry.name));
  });

  isSelected(name: string): boolean {
    return this._selection().has(name);
  }

  /** Un clic simple : cette ligne, et elle seule. */
  selectOnly(name: string): void {
    this._selection.set(new Set([name]));
    this.anchor = name;
  }

  /** Cmd/Ctrl-clic : ajoute ou retire, sans toucher au reste. */
  toggleSelection(name: string): void {
    this._selection.update((current) => {
      const next = new Set(current);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });
    this.anchor = name;
  }

  /**
   * Maj-clic : la plage de l'ancre à cette ligne, dans la liste VISIBLE (une
   * plage qui embarquerait des entrées masquées par le filtre serait une
   * mauvaise surprise.
   */
  extendTo(name: string, add = false): void {
    const visible = this.filteredEntries().map((entry) => entry.name);
    const from = this.anchor ? visible.indexOf(this.anchor) : -1;
    const to = visible.indexOf(name);
    if (to === -1) {
      return;
    }
    if (from === -1) {
      this.selectOnly(name);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    const range = visible.slice(start, end + 1);
    // ⌘⇧clic ajoute la plage ; ⇧clic la substitue.
    this._selection.set(add ? new Set([...this._selection(), ...range]) : new Set(range));
  }

  /** Tout ce qui est visible : le filtre décide de ce que « tout » veut dire. */
  selectAll(): void {
    const visible = this.filteredEntries();
    this._selection.set(new Set(visible.map((entry) => entry.name)));
    this.anchor = visible[0]?.name ?? null;
  }

  clearSelection(): void {
    this._selection.set(new Set());
    this.anchor = null;
  }

  /**
   * Le voisin d'une ligne dans la liste visible, pour la navigation aux
   * flèches. `null` s'il n'y en a pas.
   */
  neighbour(name: string | null, delta: number): string | null {
    const visible = this.filteredEntries().map((entry) => entry.name);
    if (!visible.length) {
      return null;
    }
    if (!name) {
      return delta > 0 ? visible[0] : visible[visible.length - 1];
    }
    const at = visible.indexOf(name);
    if (at === -1) {
      return visible[0];
    }
    return visible[Math.min(visible.length - 1, Math.max(0, at + delta))] ?? null;
  }

  /** La dernière ligne touchée : le point de départ des flèches. */
  focused(): string | null {
    return this.anchor;
  }

  /**
   * Dernier contenu vu, par dossier. Revenir dans un dossier connu s'affiche
   * immédiatement avec ce souvenir, et le vrai listing le remplace dès qu'il
   * arrive : la navigation coûte un rendu, plus un aller-retour d'attente.
   */
  private readonly seen = new Map<string, FileEntry[]>();

  /** Oublie les contenus mémorisés (déconnexion : ils appartenaient à la session). */
  protected clearSeen(): void {
    this.seen.clear();
    this._back.set([]);
    this._forward.set([]);
  }

  // --- Historique de navigation ---
  //
  // Deux piles, comme un navigateur : les dossiers d'où l'on vient et ceux
  // d'où l'on est revenu. Une navigation ordinaire empile le dossier quitté
  // et vide la pile avant (on repart dans une autre direction), alors que
  // reculer et avancer se transvasent l'un dans l'autre sans rien perdre.
  //
  // Un rafraîchissement du MÊME dossier n'entre pas dans l'historique : ce
  // n'est pas un déplacement, et il ferait un doublon à chaque touche F5.

  private readonly _back = signal<string[]>([]);
  private readonly _forward = signal<string[]>([]);

  readonly canGoBack = computed(() => this._back().length > 0);
  readonly canGoForward = computed(() => this._forward().length > 0);

  /** Le dossier précédent, pour l'infobulle du bouton. */
  readonly backTarget = computed(() => this._back().at(-1) ?? null);
  readonly forwardTarget = computed(() => this._forward().at(-1) ?? null);

  /** Revient au dossier précédent. */
  async goBack(): Promise<boolean> {
    const target = this._back().at(-1);
    if (!target) {
      return false;
    }
    const from = this._currentPath();
    this._back.update((stack) => stack.slice(0, -1));
    const ok = await this.listDir(target, { history: false });
    if (ok) {
      this._forward.update((stack) => [...stack, from]);
    }
    return ok;
  }

  /** Repart en avant, après un retour. */
  async goForward(): Promise<boolean> {
    const target = this._forward().at(-1);
    if (!target) {
      return false;
    }
    const from = this._currentPath();
    this._forward.update((stack) => stack.slice(0, -1));
    const ok = await this.listDir(target, { history: false });
    if (ok) {
      this._back.update((stack) => [...stack, from]);
    }
    return ok;
  }

  /** Récupère le contenu brut d'un dossier. */
  protected abstract fetchEntries(path: string): Promise<FileEntryDto[]>;

  protected abstract createDir(path: string): Promise<void>;
  protected abstract createFile(path: string): Promise<void>;
  protected abstract removeEntry(path: string, isDir: boolean): Promise<void>;
  protected abstract renameEntry(from: string, to: string): Promise<void>;

  async listDir(path: string, options: { history?: boolean } = {}): Promise<boolean> {
    const remembered = this.seen.get(path);
    const changingDir = path !== this._currentPath();

    // Un déplacement ordinaire empile le dossier quitté et ferme la voie
    // d'en face : on vient de repartir dans une autre direction.
    if (changingDir && options.history !== false) {
      const from = this._currentPath();
      this._back.update((stack) => [...stack.slice(-49), from]);
      this._forward.set([]);
    }

    // Dossier déjà vu : il s'affiche tout de suite, le vrai listing suit sans
    // indicateur de chargement. Le refresh du dossier courant, lui, garde le
    // chemin classique : on veut voir qu'il travaille.
    if (remembered && changingDir) {
      this.filter.set('');
      this.kindFilter.set('all');
      this.clearSelection();
      this._entries.set(remembered);
      this._currentPath.set(path);
      this._error.set(null);
      try {
        const fresh = this.toEntries(await this.fetchEntries(path));
        this.seen.set(path, fresh);
        // L'utilisateur a pu repartir pendant le voyage de la réponse.
        if (this._currentPath() === path) {
          this._entries.set(fresh);
        }
      } catch (error) {
        // Le souvenir était faux (dossier supprimé, droits retirés) : le dire,
        // sans jeter ce qui est affiché.
        if (this._currentPath() === path) {
          this._error.set(this.toMessage(error));
        }
      }
      return true;
    }

    const entries = await this.run(() => this.fetchEntries(path));
    if (entries === undefined) {
      return false;
    }

    // Changer de dossier vide le filtre : il décrivait l'ancien contenu. Un
    // refresh (même chemin) le garde, on est toujours au même endroit.
    if (changingDir) {
      this.filter.set('');
      this.kindFilter.set('all');
      // La sélection désignait le contenu d'ailleurs.
      this.clearSelection();
    }
    const mapped = this.toEntries(entries);
    this.seen.set(path, mapped);
    this._entries.set(mapped);
    this._currentPath.set(path);
    return true;
  }

  private toEntries(entries: FileEntryDto[]): FileEntry[] {
    return entries.map((e) => ({
      name: e.name,
      isDir: e.is_dir,
      size: e.size,
      mode: e.mode,
      owner: e.owner,
      group: e.group,
    }));
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

  /**
   * Relit le dossier courant SANS indicateur de chargement ni message
   * d'erreur : pour les rafraîchissements que l'utilisateur n'a pas demandés
   * (après une commande tapée dans le terminal, par exemple), où un
   * clignotement à chaque Entrée serait pénible. Silencieux jusqu'au bout :
   * personne n'attend de réponse, un échec laisse simplement l'affichage tel
   * qu'il est.
   */
  async refreshQuietly(): Promise<void> {
    const path = this._currentPath();
    try {
      const fresh = this.toEntries(await this.fetchEntries(path));
      this.seen.set(path, fresh);
      // L'utilisateur a pu naviguer ailleurs pendant le voyage de la réponse.
      if (this._currentPath() === path) {
        this._entries.set(fresh);
      }
    } catch {
      // Rien à dire : ce rafraîchissement n'a été demandé par personne.
    }
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

  /**
   * Supprime sans rafraîchir : une suppression en lot relit le dossier une
   * seule fois, à la fin. Les garde-fous de `removeEntry` (lecture seule,
   * escalade sudo côté serveur) restent ceux du navigateur concerné.
   */
  async removeSilently(path: string, isDir: boolean): Promise<void> {
    await this.removeEntry(path, isDir);
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

  /**
   * Le message d'une erreur, traduit s'il vient du backend sous forme de code.
   *
   * C'est l'entonnoir : listing, création, suppression, renommage passent tous
   * par `run`/`runVoid`, donc par ici. Traduire à cet endroit couvre d'un coup
   * tout ce que les deux navigateurs affichent en cas d'échec.
   */
  private toMessage(error: unknown): string {
    return this.errorText(error);
  }
}
