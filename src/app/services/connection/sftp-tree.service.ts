import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { FileEntry, FileEntryDto, TreeNode } from '@app/interfaces';
import { SftpService } from '@app/services/connection/sftp.service';

const freshRoot = (): TreeNode => ({
  name: '/',
  path: '/',
  isDir: true,
  expanded: false,
  loading: false,
  children: null,
});

/** Tri d'affichage : dossiers d'abord, puis ordre alphabétique. */
const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
  [...nodes].sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );

/** Le chemin `ancestor` contient-il `path` (strictement) ? */
const isAncestor = (ancestor: string, path: string): boolean =>
  ancestor === '/' ? path !== '/' : path.startsWith(`${ancestor}/`);

/** Applique `patch` au nœud `path` (copie immuable le long de la branche). */
const mapNode = (node: TreeNode, path: string, patch: (n: TreeNode) => TreeNode): TreeNode => {
  if (node.path === path) {
    return patch(node);
  }
  if (!node.children || !isAncestor(node.path, path)) {
    return node;
  }
  return { ...node, children: node.children.map((child) => mapNode(child, path, patch)) };
};

const childPath = (parent: string, name: string): string =>
  parent === '/' ? `/${name}` : `${parent}/${name}`;

const findNode = (node: TreeNode, path: string): TreeNode | null => {
  if (node.path === path) {
    return node;
  }
  if (!node.children || !isAncestor(node.path, path)) {
    return null;
  }
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) {
      return found;
    }
  }
  return null;
};

/** Ce que le moteur d'arbre demande à son système de fichiers. */
export interface TreeSource {
  /** Faut-il tenir l'arbre (connecté côté serveur, toujours côté local) ? */
  active(): boolean;
  currentPath(): string;
  /** Les entrées du dossier courant, celles de la vue principale. */
  entries(): FileEntry[];
  /** Liste un dossier quelconque, ou `null` si la lecture échoue. */
  fetchEntries(path: string): Promise<FileEntryDto[] | null>;
}

/**
 * Arborescence d'un système de fichiers (dossiers ET fichiers) : chargement
 * paresseux à l'expansion, dépliage automatique jusqu'au dossier courant de
 * la vue principale, tri dossiers d'abord.
 *
 * MOTEUR paramétré par une `TreeSource` : la même mécanique sert l'arbre
 * serveur (une instance par session) et l'arbre local (issue #9). Les deux
 * bugs payés fin août (le nœud faussement vide, le listing pas encore
 * arrivé) vivent ici et n'existent donc qu'en un exemplaire.
 */
export class FileTree {
  private readonly _root = signal<TreeNode>(freshRoot());

  /** Sérialise les dépliages automatiques pour éviter les courses. */
  private revealQueue = Promise.resolve();

  readonly root = this._root.asReadonly();

  constructor(private readonly source: TreeSource) {
    effect(() => {
      const connected = this.source.active();
      const path = this.source.currentPath();
      if (!connected) {
        this._root.set(freshRoot());
        return;
      }
      untracked(() => {
        this.revealQueue = this.revealQueue.then(() => this.reveal(path));
      });
    });

    // La liste principale fait foi pour le dossier courant : après un
    // mkdir/suppression/renommage, l'arbre suit sans requête supplémentaire.
    //
    // Cet effet RÉPARE aussi le dépliage : si le dossier courant n'est pas
    // dans l'arbre (chaîne abandonnée parce que la connexion n'était pas
    // prête au tout début), l'arrivée d'un listing est l'occasion de rejouer
    // le dépliage. Sans ce rattrapage, l'arbre restait figé sur sa racine
    // jusqu'au premier clic de l'utilisateur.
    effect(() => {
      if (!this.source.active()) {
        return;
      }
      const path = this.source.currentPath();
      const entries = this.source.entries();
      untracked(() => {
        const node = findNode(this._root(), path);
        if (!node || (node.children === null && !node.expanded)) {
          this.revealQueue = this.revealQueue.then(() => this.reveal(path));
          return;
        }
        this.mergeChildren(path, entries);
      });
    });
  }

  /** Aligne les enfants d'un nœud déjà matérialisé sur la liste principale,
   *  en préservant l'état de dépliage des sous-arbres existants. */
  private mergeChildren(path: string, entries: FileEntry[]): void {
    this.patch(path, (node) => {
      if (node.children === null && !node.expanded) {
        return node;
      }
      const existing = new Map((node.children ?? []).map((child) => [child.name, child]));
      const children = entries.map((entry) => {
        const kept = existing.get(entry.name);
        // Réutilise le sous-arbre existant (état de dépliage) si le type n'a pas changé.
        return kept && kept.isDir === entry.isDir
          ? kept
          : {
              name: entry.name,
              path: childPath(path, entry.name),
              isDir: entry.isDir,
              expanded: false,
              loading: false,
              children: null,
            };
      });
      return { ...node, children: sortNodes(children) };
    });
  }

  /** Déplie (en rechargeant les enfants) ou replie un nœud. */
  async toggle(node: TreeNode): Promise<void> {
    if (!node.isDir) {
      return;
    }
    if (node.expanded) {
      this.patch(node.path, (n) => ({ ...n, expanded: false }));
      return;
    }
    await this.expand(node.path);
  }

  /** Déplie un nœud en rafraîchissant sa liste de sous-dossiers. */
  private async expand(path: string): Promise<void> {
    this.patch(path, (n) => ({ ...n, expanded: true, loading: true, error: null }));
    const children = await this.fetchChildren(path);
    if (children === null) {
      // Échec de lecture (au démarrage, la connexion n'est pas toujours prête
      // quand l'arbre se déplie ; ou dossier devenu illisible). On REPLIE en
      // laissant `children` à null, c'est-à-dire « pas encore chargé ».
      //
      // L'ancienne version posait `[]` : le nœud restait déplié et
      // FAUSSEMENT vide, la chaîne du dépliage automatique ne trouvait plus
      // rien dessous et abandonnait, et plus personne ne retentait. L'arbre
      // affichait un `/` vide jusqu'à ce qu'on clique dedans à la main.
      // Deux échecs très différents, et ils ne se traitent pas pareil.
      //
      // SANS raison, c'est que la source n'était pas prête (au démarrage, la
      // connexion n'est pas toujours ouverte quand l'arbre se déplie). On
      // REPLIE en laissant `children` à null, c'est-à-dire « pas encore
      // chargé » : l'effet qui suit les entrées rejouera le dépliage. Poser
      // une erreur ici figerait le nœud et personne ne retenterait.
      //
      // AVEC une raison, c'est un vrai refus (droits, dossier disparu,
      // autorisation macOS pas accordée). Le nœud reste alors DÉPLIÉ et le
      // dit : un chevron qui se referme tout seul ne se diagnostique pas.
      const reason = this.lastError;
      this.patch(path, (n) => ({
        ...n,
        loading: false,
        expanded: reason !== null,
        error: reason,
      }));
      return;
    }
    this.patch(path, (n) => ({ ...n, loading: false, children, error: null }));
  }

  /**
   * Déplie la chaîne de dossiers menant à `path`, sans refetch de l'existant.
   *
   * Le dossier CIBLE ne coûte jamais de requête : la vue principale vient de
   * le lister, ses entrées sont déjà là. Ne partent au réseau que les
   * ancêtres jamais matérialisés — et en navigation ordinaire (descendre d'un
   * cran), ils sont déjà tous dépliés : zéro requête d'arbre.
   */
  private async reveal(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const chain = ['/', ...segments.map((_, i) => `/${segments.slice(0, i + 1).join('/')}`)];
    for (const step of chain) {
      const node = findNode(this._root(), step);
      if (!node) {
        return;
      }
      if (step === path) {
        const entries = this.source.entries();
        if (entries.length === 0) {
          // Le listing de la vue principale n'est pas encore arrivé : au
          // démarrage, l'arbre se déplie AVANT lui. S'en servir quand même
          // figerait le dossier sur une liste vide, et plus rien ne le
          // corrigerait (l'arbre affichait un « / » vide jusqu'au premier
          // clic). On va donc le chercher. Une requête de trop quand le
          // dossier est réellement vide, ce qui ne coûte rien.
          await this.expand(step);
          return;
        }
        this.patch(step, (n) => ({ ...n, expanded: true }));
        this.mergeChildren(step, entries);
        return;
      }
      if (!node.expanded || node.children === null) {
        await this.expand(step);
      }
    }
  }

  private patch(path: string, fn: (n: TreeNode) => TreeNode): void {
    this._root.update((root) => mapNode(root, path, fn));
  }

  /** La raison du dernier échec de lecture, pour l'afficher sur le nœud. */
  private lastError: string | null = null;

  /** Une source signale pourquoi la lecture a échoué. */
  protected noteError(error: unknown): void {
    const raw = typeof error === 'string' ? error : String(error);
    // Le message balisé du backend porte son détail après un séparateur.
    this.lastError = raw.split('\u001f').pop()?.trim() || raw;
  }

  private async fetchChildren(path: string): Promise<TreeNode[] | null> {
    this.lastError = null;
    const entries = await this.source.fetchEntries(path);
    if (entries === null) {
      return null;
    }
    return sortNodes(
      entries.map((entry) => ({
        name: entry.name,
        path: childPath(path, entry.name),
        isDir: entry.is_dir,
        expanded: false,
        loading: false,
        children: null,
      })),
    );
  }
}

/** L'arbre du serveur : le moteur branché sur la session SFTP. */
@Injectable({ providedIn: 'root' })
export class SftpTreeService extends FileTree {
  constructor() {
    const sftp = inject(SftpService);
    super({
      active: () => sftp.connected(),
      currentPath: () => sftp.currentPath(),
      entries: () => sftp.entries(),
      fetchEntries: async (path) => {
        const connectionId = sftp.connectionId();
        if (!connectionId) {
          return null;
        }
        try {
          return await invoke<FileEntryDto[]>(sftp.commandFor('list_dir'), {
            connectionId,
            path,
          });
        } catch (error) {
          this.noteError(error);
          return null;
        }
      },
    });
  }
}
