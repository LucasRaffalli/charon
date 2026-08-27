import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { SearchHit, SearchService } from '@app/services/connection/search.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { fileIconFor } from '@app/services/files/file-icon';
import { PreviewService } from '@app/services/files/preview.service';
import { DockService } from '@app/services/workspace/dock.service';

/** Un résultat de contenu, regroupé sous son fichier. */
interface HitGroup {
  path: string;
  name: string;
  hits: SearchHit[];
}

/**
 * Le panneau Recherche : la liste complète des résultats de la recherche
 * récursive, au fil de l'eau, avec la raison d'arrêt toujours affichée.
 */
@Component({
  selector: 'app-search-pane',
  imports: [Icon, SegmentedControl],
  templateUrl: './search-pane.html',
  styleUrl: './search-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchPane {
  protected readonly search = inject(SearchService);
  protected readonly sftp = inject(SftpService);
  private readonly preview = inject(PreviewService);
  private readonly dock = inject(DockService);

  // FTP n'a pas de canal exec : l'option Contenu disparaît et une notice du
  // panneau dit pourquoi, plutôt qu'un segment mystérieusement mort.
  protected readonly modeOptions = computed<readonly SegmentedOption[]>(() =>
    this.search.contentAvailable()
      ? [
          { value: 'names', label: 'Noms' },
          { value: 'content', label: 'Contenu' },
        ]
      : [{ value: 'names', label: 'Noms' }],
  );

  /** La recherche de contenu se lit mieux regroupée par fichier. */
  protected readonly groups = computed<HitGroup[]>(() => {
    const groups: HitGroup[] = [];
    let current: HitGroup | null = null;
    for (const hit of this.search.hits()) {
      if (!current || current.path !== hit.path) {
        current = { path: hit.path, name: baseName(hit.path), hits: [] };
        groups.push(current);
      }
      current.hits.push(hit);
    }
    return groups;
  });

  /** Ce que la ligne de statut raconte : l'état, puis la raison d'arrêt. */
  protected readonly status = computed(() => {
    if (this.search.error()) {
      return null; // l'erreur a sa propre ligne
    }
    const total = this.search.total();
    if (this.search.running()) {
      return { kind: 'pending' as const, text: `Recherche en cours… ${total} résultat(s)` };
    }
    switch (this.search.doneReason()) {
      case 'complete':
        return { kind: 'success' as const, text: `${total} résultat(s)` };
      case 'cap':
        return {
          kind: 'warning' as const,
          text: `Plafond atteint : les ${total} premiers résultats sont affichés`,
        };
      case 'timeout':
        return { kind: 'warning' as const, text: `Délai dépassé : ${total} résultat(s) partiels` };
      case 'cancelled':
        return { kind: 'muted' as const, text: `Arrêtée : ${total} résultat(s)` };
      default:
        return null;
    }
  });

  protected readonly scopeLabel = computed(() => {
    const scope = this.search.scope();
    if (scope === '/') {
      return 'tout le serveur';
    }
    return scope ?? 'dossier affiché';
  });

  protected onMode(value: string): void {
    this.search.mode.set(value as 'names' | 'content');
  }

  protected toggleScope(): void {
    // Deux positions utiles : le dossier affiché, ou tout le serveur. Une
    // portée posée par le clic droit se remplace par ce geste.
    this.search.scope.set(this.search.scope() === null ? '/' : null);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      void this.search.start();
    }
  }

  protected iconFor(hit: SearchHit): IconName {
    return hit.isDir ? 'folder' : fileIconFor(baseName(hit.path));
  }

  /**
   * Ouvrir un résultat : un dossier s'affiche dans l'explorateur, un fichier
   * dans l'aperçu. `find` ne dit pas la nature, un `stat` tranche.
   */
  protected async open(hit: SearchHit): Promise<void> {
    if (hit.line !== null) {
      // Un résultat de contenu est forcément un fichier.
      this.dock.openPanel('preview');
      await this.preview.openFile(hit.path, baseName(hit.path));
      return;
    }
    const isDir = hit.isDir || ((await this.sftp.stat(hit.path))?.isDir ?? false);
    if (isDir) {
      await this.sftp.listDir(hit.path);
    } else {
      this.dock.openPanel('preview');
      await this.preview.openFile(hit.path, baseName(hit.path));
    }
  }

  /** Le dossier du résultat, pour la ligne secondaire. */
  protected parentOf(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut <= 0 ? '/' : path.slice(0, cut);
  }

  protected nameOf(path: string): string {
    return baseName(path);
  }
}

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;
