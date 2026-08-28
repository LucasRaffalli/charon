import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { SftpService } from '@app/services/connection/sftp.service';
import { DialogService } from '@app/services/workspace/dialog.service';
import { analysePattern } from '@app/services/workspace/regex-portability';

/** Ce qu'on cherche : des noms de fichiers, ou des lignes de contenu. */
export type SearchMode = 'names' | 'content';

/** Un résultat, tel que le backend l'émet. */
export interface SearchHit {
  path: string;
  /** Numéro de ligne, pour une recherche de contenu. */
  line: number | null;
  /** La ligne trouvée, tronquée, pour une recherche de contenu. */
  text: string | null;
  isDir: boolean;
}

/** Pourquoi la recherche s'est arrêtée. Jamais de troncature silencieuse. */
export type SearchDoneReason = 'complete' | 'cap' | 'timeout' | 'cancelled';

interface HitBatch {
  id: string;
  hits: SearchHit[];
}

interface DoneEvent {
  id: string;
  total: number;
  reason: SearchDoneReason;
}

interface ErrorEvent {
  id: string;
  message: string;
}

/** Un littéral devient un motif ERE en échappant tout ce qui a un sens. */
const escapeForEre = (raw: string): string => raw.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');

/**
 * La recherche récursive sur le serveur (portée C de docs/search.md).
 *
 * Le travail se fait côté Rust (`search.rs`) : exec `find`/`grep` en SFTP,
 * walk en repli, résultats au fil de l'eau. Ici vivent l'état du panneau, les
 * garde-fous d'avant-lancement (motif valide, portable, confirmation sur un
 * serveur de production) et l'accumulation des résultats.
 */
@Injectable({ providedIn: 'root' })
export class SearchService {
  private readonly sftp = inject(SftpService);
  private readonly dialog = inject(DialogService);

  /** La saisie et ses options : elles survivent aux fermetures du panneau. */
  readonly query = signal('');
  readonly mode = signal<SearchMode>('names');
  readonly regex = signal(false);
  readonly caseSensitive = signal(false);

  /**
   * D'où l'on cherche : null = le dossier affiché au moment du lancement.
   * Posé par « Rechercher en profondeur » du clic droit, ou par la pastille
   * « tout le serveur » du panneau.
   */
  readonly scope = signal<string | null>(null);

  /**
   * Ce qui a lancé la recherche affichée : c'est ce motif-là qu'un clic sur un
   * résultat re-cherche dans le fichier ouvert, pas la saisie du moment, qui a
   * pu changer depuis.
   */
  readonly launched = signal<{ query: string; regex: boolean; caseSensitive: boolean } | null>(
    null,
  );

  readonly running = signal(false);
  readonly hits = signal<SearchHit[]>([]);
  readonly total = computed(() => this.hits().length);
  /** La racine réellement utilisée par la recherche en cours ou finie. */
  readonly searchedRoot = signal('');
  readonly doneReason = signal<SearchDoneReason | null>(null);
  readonly error = signal<string | null>(null);

  /** La recherche de contenu demande un canal exec, donc une session SSH. */
  readonly contentAvailable = computed(() => this.sftp.protocol() === 'sftp');

  private searchId: string | null = null;

  constructor() {
    // Les résultats appartiennent à la session : la déconnexion les emporte.
    effect(() => {
      if (!this.sftp.connected()) {
        this.reset();
      }
    });

    void listen<HitBatch>('search:hit', (event) => {
      if (event.payload.id === this.searchId) {
        this.hits.update((list) => [...list, ...event.payload.hits]);
      }
    });
    void listen<DoneEvent>('search:done', (event) => {
      if (event.payload.id === this.searchId) {
        this.running.set(false);
        this.doneReason.set(event.payload.reason);
      }
    });
    void listen<ErrorEvent>('search:error', (event) => {
      if (event.payload.id === this.searchId) {
        this.running.set(false);
        this.error.set(event.payload.message);
      }
    });
  }

  /** Prépare une recherche depuis ailleurs (palette, clic droit). */
  seed(query: string, scope: string | null = null): void {
    if (query) {
      this.query.set(query);
    }
    this.scope.set(scope);
  }

  async start(): Promise<void> {
    const raw = this.query().trim();
    if (!raw || this.running() || !this.sftp.connected()) {
      return;
    }
    const content = this.mode() === 'content';
    if (content && !this.contentAvailable()) {
      this.error.set('La recherche de contenu demande une session SSH (SFTP).');
      return;
    }

    // Le motif part vers grep -E : en mode texte on échappe tout, en mode
    // regex on exige un motif valide ET portable — jamais transmis sinon.
    let pattern: string;
    let plain: string | null;
    if (this.regex()) {
      const report = analysePattern(raw);
      if (!report.valid) {
        this.error.set(`Motif invalide : ${report.error}`);
        return;
      }
      if (report.posix === null) {
        this.error.set(`Le serveur ne comprendra pas ce motif : ${report.notPortable.join(', ')}.`);
        return;
      }
      pattern = report.posix;
      plain = null;
    } else {
      pattern = escapeForEre(raw);
      plain = raw;
    }

    const root = this.scope() ?? this.sftp.currentPath();

    // Chercher dans tout le contenu d'un serveur de production n'est pas un
    // geste anodin : même confirmation renforcée que les suppressions.
    if (content && root === '/' && this.sftp.environment() === 'prod') {
      const host = this.sftp.host();
      const typed = await this.dialog.prompt({
        title: 'Serveur de production',
        message: `Chercher dans tout le contenu de ce serveur peut le faire travailler longtemps. Tape « ${host} » pour confirmer.`,
        placeholder: host,
        confirmLabel: 'Chercher',
        danger: true,
      });
      if (typed?.trim() !== host) {
        return;
      }
    }

    this.hits.set([]);
    this.error.set(null);
    this.doneReason.set(null);
    this.searchedRoot.set(root);
    this.launched.set({ query: raw, regex: this.regex(), caseSensitive: this.caseSensitive() });
    this.running.set(true);
    try {
      this.searchId = await invoke<string>('search_start', {
        connectionId: this.sftp.connectionId(),
        root,
        pattern,
        content,
        caseSensitive: this.caseSensitive(),
        plain,
      });
    } catch (err) {
      this.running.set(false);
      this.error.set(typeof err === 'string' ? err : String(err));
    }
  }

  stop(): void {
    const id = this.searchId;
    if (id && this.running()) {
      void invoke('search_stop', { searchId: id }).catch(() => undefined);
    }
  }

  /** Tout remettre à blanc (déconnexion). */
  reset(): void {
    this.stop();
    this.searchId = null;
    this.hits.set([]);
    this.error.set(null);
    this.doneReason.set(null);
    this.running.set(false);
    this.scope.set(null);
    this.launched.set(null);
  }
}
