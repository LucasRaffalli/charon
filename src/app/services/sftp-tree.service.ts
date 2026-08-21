import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { FileEntry, FileEntryDto, TreeNode } from '@app/interfaces';
import { SftpService } from '@app/services/sftp.service';

const freshRoot = (): TreeNode => ({
  name: '/',
  path: '/',
  expanded: false,
  loading: false,
  children: null,
});

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

/**
 * Arborescence des dossiers du serveur : chargement paresseux à l'expansion,
 * et dépliage automatique jusqu'au dossier courant de la vue principale.
 */
@Injectable({ providedIn: 'root' })
export class SftpTreeService {
  private readonly sftp = inject(SftpService);
  private readonly _root = signal<TreeNode>(freshRoot());

  /** Sérialise les dépliages automatiques pour éviter les courses. */
  private revealQueue = Promise.resolve();

  readonly root = this._root.asReadonly();

  constructor() {
    effect(() => {
      const connected = this.sftp.connected();
      const path = this.sftp.currentPath();
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
    effect(() => {
      if (!this.sftp.connected()) {
        return;
      }
      const path = this.sftp.currentPath();
      const entries = this.sftp.entries();
      untracked(() => this.mergeChildren(path, entries));
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
      const children = entries
        .filter((entry) => entry.isDir)
        .map(
          (entry) =>
            existing.get(entry.name) ?? {
              name: entry.name,
              path: childPath(path, entry.name),
              expanded: false,
              loading: false,
              children: null,
            },
        );
      return { ...node, children };
    });
  }

  /** Déplie (en rechargeant les enfants) ou replie un nœud. */
  async toggle(node: TreeNode): Promise<void> {
    if (node.expanded) {
      this.patch(node.path, (n) => ({ ...n, expanded: false }));
      return;
    }
    await this.expand(node.path);
  }

  /** Déplie un nœud en rafraîchissant sa liste de sous-dossiers. */
  private async expand(path: string): Promise<void> {
    this.patch(path, (n) => ({ ...n, expanded: true, loading: true }));
    const children = await this.fetchDirs(path);
    this.patch(path, (n) => ({
      ...n,
      loading: false,
      children: children ?? n.children ?? [],
    }));
  }

  /** Déplie la chaîne de dossiers menant à `path` (sans refetch de l'existant). */
  private async reveal(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    let current = '/';
    const chain = ['/', ...segments.map((_, i) => `/${segments.slice(0, i + 1).join('/')}`)];
    for (const step of chain) {
      current = step;
      const node = findNode(this._root(), current);
      if (!node) {
        return;
      }
      if (!node.expanded || node.children === null) {
        await this.expand(current);
      }
    }
  }

  private patch(path: string, fn: (n: TreeNode) => TreeNode): void {
    this._root.update((root) => mapNode(root, path, fn));
  }

  private async fetchDirs(path: string): Promise<TreeNode[] | null> {
    const connectionId = this.sftp.connectionId();
    if (!connectionId) {
      return null;
    }
    try {
      const entries = await invoke<FileEntryDto[]>('sftp_list_dir', { connectionId, path });
      return entries
        .filter((entry) => entry.is_dir)
        .map((entry) => ({
          name: entry.name,
          path: childPath(path, entry.name),
          expanded: false,
          loading: false,
          children: null,
        }));
    } catch {
      return null;
    }
  }
}
