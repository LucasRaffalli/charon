import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { injectSessionActivity } from '@app/services/workspace/activity-log.service';
import { ensureHighlighter, highlightCode, languageFor } from '@app/services/files/code-highlight';
import { DialogService } from '@app/services/workspace/dialog.service';
import { formatCode } from '@app/services/files/code-format';
import { fileIconFor } from '@app/services/files/file-icon';
import { ensureMarkdown, renderMarkdown } from '@app/services/files/markdown';
import { SftpService } from '@app/services/connection/sftp.service';
import { SettingsService } from '@app/services/system/settings.service';
import { ToastService } from '@app/services/workspace/toast.service';
import { injectT } from '@app/lang/i18n.service';

export type PreviewKind = 'loading' | 'text' | 'image' | 'binary' | 'error';

/** Une occurrence trouvée dans le fichier ouvert (portée B de docs/search.md). */
export interface FindMatch {
  start: number;
  end: number;
  /** Ligne (à partir de 1), pour le compteur et le saut depuis la recherche. */
  line: number;
}

/**
 * Un document ouvert dans l'aperçu (v2 : des onglets, plusieurs fichiers).
 * Tout l'état du fichier vit ici ; le service n'expose plus qu'un jeu de
 * vues sur le document ACTIF, si bien que l'éditeur, ⌘F, le markdown et
 * Prettier n'ont pas eu à changer.
 */
export interface PreviewDoc {
  id: number;
  /** Ordre d'ouverture GLOBAL (toutes sessions confondues) : l'ordre des onglets. */
  seq: number;
  path: string;
  name: string;
  kind: PreviewKind;
  content: string;
  original: string;
  imageSrc: string;
  readonly: boolean;
  truncated: boolean;
  error: string | null;
  highlighted: string | null;
  language: string | null;
  isMarkdown: boolean;
  markdownView: boolean;
  /** Métadonnées pour l'en-tête (0 = inconnu). */
  size: number;
  mtime: number;
  mode?: number;
}

/**
 * Plafond d'occurrences : au-delà, chercher une lettre dans un gros fichier
 * fabriquerait des dizaines de milliers de marques dans le DOM.
 */
const MAX_FIND_MATCHES = 2000;

const escapeHtml = (raw: string): string =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Taille max lue pour l'aperçu/édition (au-delà : aperçu tronqué en lecture seule). */
const PREVIEW_MAX = 512 * 1024;

/** Plafond dur : au-delà, aucune coloration (une passe Prism serait trop lourde). */
const HIGHLIGHT_MAX = 200_000;

/**
 * La coloration est recalculée à chaque frappe : si la passe d'ouverture
 * dépasse ce budget (ms), le fichier est trop lourd pour rester fluide et on
 * repasse en textarea nu plutôt que de faire ramer la saisie.
 */
const HIGHLIGHT_BUDGET_MS = 40;

/**
 * En dessous de cette taille, Prism est de toute façon rapide : on ne
 * chronomètre pas, pour qu'un hoquet ponctuel (GC) ne prive pas un petit
 * fichier de couleurs pour toute la session d'édition.
 */
const HIGHLIGHT_MEASURE_MIN = 20_000;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** L'ordre d'ouverture et les identités, partagés par TOUTES les sessions. */
let NEXT_SEQ = 1;
let NEXT_DOC = 1;

/**
 * Aperçu / édition intégré (panneau de droite) : texte éditable enregistrable,
 * image en aperçu, et depuis la v2, PLUSIEURS documents en onglets. SFTP
 * uniquement. Respecte les garde-fous (lecture seule, confirmation par nom
 * d'hôte sur serveur protégé).
 */
@Injectable({ providedIn: 'root' })
export class PreviewService {
  constructor() {
    effect((onCleanup) => {
      const query = this.findQuery();
      if (!query) {
        this.findNeedle.set('');
        return;
      }
      const handle = setTimeout(() => this.findNeedle.set(query), 120);
      onCleanup(() => clearTimeout(handle));
    });
  }

  private readonly t = injectT();
  private readonly sftp = inject(SftpService);
  private readonly dialog = inject(DialogService);
  private readonly activity = injectSessionActivity();
  private readonly toasts = inject(ToastService);
  private readonly settings = inject(SettingsService);

  private readonly _docs = signal<PreviewDoc[]>([]);
  private readonly _activeId = signal<number | null>(null);
  private readonly _saving = signal(false);

  /** Les documents ouverts dans CETTE session, dans l'ordre d'ouverture. */
  readonly docs = this._docs.asReadonly();
  readonly activeId = this._activeId.asReadonly();

  /** Le document actif de cette session. */
  readonly active = computed<PreviewDoc | null>(
    () => this._docs().find((doc) => doc.id === this._activeId()) ?? null,
  );

  readonly open = computed(() => this._docs().length > 0);

  /** Quand cette session a touché l'aperçu pour la dernière fois : c'est ce
   *  qui départage les sessions pour savoir quel document le panneau montre. */
  private readonly _openedAt = signal(0);
  readonly openedAt = this._openedAt.asReadonly();

  // ---------- L'API historique : des vues sur le document actif ----------

  readonly name = computed(() => this.active()?.name ?? '');
  readonly path = computed(() => this.active()?.path ?? '');
  readonly kind = computed<PreviewKind>(() => this.active()?.kind ?? 'loading');
  readonly content = computed(() => this.active()?.content ?? '');
  readonly imageSrc = computed(() => this.active()?.imageSrc ?? '');
  readonly readonly = computed(() => this.active()?.readonly ?? false);
  readonly truncated = computed(() => this.active()?.truncated ?? false);
  readonly saving = this._saving.asReadonly();
  readonly error = computed(() => this.active()?.error ?? null);

  /** HTML Prism du contenu courant (`null` = textarea nu). */
  readonly highlighted = computed(() => this.active()?.highlighted ?? null);

  /** Icône du fichier ouvert, d'après son type. */
  readonly icon = computed(() => fileIconFor(this.name()));

  readonly isMarkdown = computed(() => this.active()?.isMarkdown ?? false);
  readonly markdownView = computed(() => this.active()?.markdownView ?? false);

  /** Métadonnées de l'en-tête riche. */
  readonly fileSize = computed(() => this.active()?.size ?? 0);
  readonly fileMtime = computed(() => this.active()?.mtime ?? 0);
  readonly fileMode = computed(() => this.active()?.mode);

  // ---------- Recherche dans le fichier (portée B) ----------

  /** La barre est ouverte. La saisie survit à sa fermeture, pas à un autre fichier. */
  readonly findOpen = signal(false);
  readonly findQuery = signal('');
  /** La saisie posée 120 ms après la dernière frappe : c'est ELLE que le
   *  scan lit. Chercher à chaque caractère rescannait tout le fichier et
   *  reconstruisait la couche d'occurrences, deux passes complètes par
   *  frappe. Vider reste instantané (effacer doit se voir tout de suite). */
  private readonly findNeedle = signal('');
  readonly findRegex = signal(false);
  readonly findCase = signal(false);
  private readonly _findIndex = signal(0);

  /** En mode regex, un motif qui ne compile pas : signalé, jamais utilisé. */
  readonly findInvalid = computed(() => {
    if (!this.findRegex() || !this.findQuery()) {
      return false;
    }
    try {
      new RegExp(this.findQuery());
      return false;
    } catch {
      return true;
    }
  });

  /**
   * Les occurrences dans le contenu courant. Recalculées à chaque frappe des
   * deux côtés (le champ de recherche ET l'éditeur), comme la coloration.
   */
  readonly findMatches = computed<FindMatch[]>(() => {
    if (!this.findOpen() || this.kind() !== 'text') {
      return [];
    }
    const query = this.findNeedle();
    if (!query) {
      return [];
    }
    const content = this.content();
    const matches: FindMatch[] = [];

    if (this.findRegex()) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(query, this.findCase() ? 'g' : 'gi');
      } catch {
        return [];
      }
      let found: RegExpExecArray | null;
      while ((found = pattern.exec(content)) !== null && matches.length < MAX_FIND_MATCHES) {
        if (found[0].length === 0) {
          // Un motif qui matche vide (`a*`) n'avance pas tout seul.
          pattern.lastIndex++;
          continue;
        }
        matches.push({ start: found.index, end: found.index + found[0].length, line: 0 });
      }
    } else {
      const haystack = this.findCase() ? content : content.toLowerCase();
      const needle = this.findCase() ? query : query.toLowerCase();
      let at = haystack.indexOf(needle);
      while (at !== -1 && matches.length < MAX_FIND_MATCHES) {
        matches.push({ start: at, end: at + needle.length, line: 0 });
        at = haystack.indexOf(needle, at + needle.length);
      }
    }

    // Les lignes en une seule passe : les occurrences sont déjà dans l'ordre.
    let line = 1;
    let cursor = 0;
    for (const match of matches) {
      while (cursor < match.start) {
        if (content.charCodeAt(cursor) === 10) {
          line++;
        }
        cursor++;
      }
      match.line = line;
    }
    return matches;
  });

  readonly findCapped = computed(() => this.findMatches().length >= MAX_FIND_MATCHES);

  /** L'index courant, toujours ramené dans la liste réelle. */
  readonly findIndex = computed(() => {
    const count = this.findMatches().length;
    return count === 0 ? 0 : Math.min(this._findIndex(), count - 1);
  });

  readonly currentMatch = computed<FindMatch | null>(
    () => this.findMatches()[this.findIndex()] ?? null,
  );

  /**
   * La couche d'occurrences : le contenu entier, échappé, avec une marque par
   * occurrence. Elle se glisse SOUS la coloration (texte transparent, seuls
   * les fonds se voient) : injecter des marques dans le HTML de Prism
   * casserait ses spans.
   */
  readonly findLayer = computed<string | null>(() => {
    const matches = this.findMatches();
    if (!matches.length) {
      return null;
    }
    const content = this.content();
    const current = this.findIndex();
    const parts: string[] = [];
    let cursor = 0;
    matches.forEach((match, index) => {
      parts.push(escapeHtml(content.slice(cursor, match.start)));
      const now = index === current ? ' occ--now' : '';
      parts.push(`<mark class="occ${now}">${escapeHtml(content.slice(match.start, match.end))}</mark>`);
      cursor = match.end;
    });
    parts.push(escapeHtml(content.slice(cursor)));
    return parts.join('');
  });

  /**
   * Saut demandé sans occurrence à montrer (le motif a disparu du fichier) :
   * le panneau défile jusqu'à la ligne, à défaut de mieux. `stamp` rend deux
   * demandes de la même ligne distinctes.
   */
  readonly jumpLine = signal<{ line: number; stamp: number } | null>(null);

  openFind(): void {
    if (this.kind() === 'text') {
      this.findOpen.set(true);
    }
  }

  closeFind(): void {
    this.findOpen.set(false);
  }

  findNext(): void {
    const count = this.findMatches().length;
    if (count) {
      this._findIndex.set((this.findIndex() + 1) % count);
    }
  }

  findPrev(): void {
    const count = this.findMatches().length;
    if (count) {
      this._findIndex.set((this.findIndex() - 1 + count) % count);
    }
  }

  /**
   * Ouvre un fichier et saute à une ligne, en re-cherchant le motif qui a
   * amené ici : c'est le débouché de la recherche récursive, l'occurrence
   * arrive déjà surlignée. Si le motif ne s'y trouve plus (le fichier a bougé
   * depuis), on défile au moins jusqu'à la ligne.
   */
  async openFileAt(
    remotePath: string,
    name: string,
    jump: { line: number; query: string; regex: boolean; caseSensitive: boolean },
  ): Promise<void> {
    await this.openFile(remotePath, name);
    if (this.kind() !== 'text') {
      return;
    }
    if (jump.query) {
      this.findQuery.set(jump.query);
      this.findNeedle.set(jump.query);
      this.findRegex.set(jump.regex);
      this.findCase.set(jump.caseSensitive);
      this.findOpen.set(true);
      const at = this.findMatches().findIndex((match) => match.line >= jump.line);
      if (at >= 0) {
        this._findIndex.set(at);
        return;
      }
    }
    this.jumpLine.set({ line: jump.line, stamp: Date.now() });
  }

  /** Markdown rendu, recalculé au fil des modifications. */
  readonly renderedMarkdown = computed(() =>
    this.isMarkdown() && this.markdownView() ? renderMarkdown(this.content()) : '',
  );

  readonly dirty = computed(() => {
    const doc = this.active();
    return !!doc && doc.content !== doc.original;
  });
  readonly canSave = computed(
    () => this.kind() === 'text' && !this.readonly() && this.dirty() && !this._saving(),
  );

  // ---------- Documents ----------

  private patchDoc(id: number, patch: Partial<PreviewDoc>): void {
    this._docs.update((docs) => docs.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)));
  }

  private resetFind(): void {
    this.findOpen.set(false);
    this._findIndex.set(0);
    this.jumpLine.set(null);
  }

  /** Met un document au premier plan (et cette session devant les autres). */
  activate(id: number): void {
    if (this._docs().some((doc) => doc.id === id) && this._activeId() !== id) {
      this._activeId.set(id);
      this.resetFind();
    }
    this._openedAt.set(Date.now());
  }

  /** Un document précis est-il modifié ? (le point ambré des onglets). */
  isDirty(doc: PreviewDoc): boolean {
    return doc.kind === 'text' && doc.content !== doc.original;
  }

  /** Ferme un document ; un document modifié demande d'abord. */
  async closeDoc(id: number): Promise<void> {
    const doc = this._docs().find((candidate) => candidate.id === id);
    if (!doc) {
      return;
    }
    if (doc.kind === 'text' && !doc.readonly && doc.content !== doc.original) {
      const drop = await this.dialog.confirm({
        title: `Fermer « ${doc.name} » sans enregistrer ?`,
        message: this.t('misc.preview.unsavedLost'),
        confirmLabel: 'Fermer sans enregistrer',
        danger: true,
      });
      if (!drop) {
        return;
      }
    }
    this._docs.update((docs) => docs.filter((candidate) => candidate.id !== id));
    if (this._activeId() === id) {
      const rest = this._docs();
      this._activeId.set(rest.length ? rest[rest.length - 1].id : null);
      this.resetFind();
    }
  }

  /** Ouvre un fichier serveur dans le panneau d'aperçu (nouvel onglet, ou
   *  remise au premier plan s'il y est déjà, rechargé s'il n'a pas de
   *  modifications en cours). */
  async openFile(remotePath: string, name: string): Promise<void> {
    this._openedAt.set(Date.now());
    if (this.sftp.protocol() !== 'sftp') {
      return;
    }

    const existing = this._docs().find((doc) => doc.path === remotePath);
    if (existing) {
      this._activeId.set(existing.id);
      this.resetFind();
      if (existing.kind === 'text' && existing.content === existing.original) {
        await this.load(existing.id);
      }
      return;
    }

    // Le mode vient du listing quand le fichier ouvert en fait partie : le
    // stat SFTP ne porte pas les permissions.
    const entry = this.sftp
      .entries()
      .find((candidate) => this.sftp.pathTo(candidate.name) === remotePath);

    const language = languageFor(name);
    const doc: PreviewDoc = {
      id: NEXT_DOC++,
      seq: NEXT_SEQ++,
      path: remotePath,
      name,
      kind: 'loading',
      content: '',
      original: '',
      imageSrc: '',
      readonly: false,
      truncated: false,
      error: null,
      highlighted: null,
      language,
      isMarkdown: language === 'markdown',
      // Un .md s'ouvre sur son rendu : c'est ce qu'on veut voir en premier.
      markdownView: language === 'markdown',
      size: 0,
      mtime: 0,
      mode: entry?.mode,
    };
    this._docs.update((docs) => [...docs, doc]);
    this._activeId.set(doc.id);
    this.resetFind();
    await this.load(doc.id);
  }

  /** Charge (ou recharge) le contenu d'un document depuis le serveur. */
  private async load(id: number): Promise<void> {
    const doc = this._docs().find((candidate) => candidate.id === id);
    if (!doc) {
      return;
    }
    const ext = doc.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_MIME[ext];
    if (mime) {
      const b64 = await invoke<string>('sftp_read_base64', {
        connectionId: this.sftp.connectionId(),
        path: doc.path,
        maxBytes: 4 * 1024 * 1024,
      }).catch(() => undefined);
      if (b64 === undefined) {
        this.patchDoc(id, { kind: 'error', error: this.t('misc.preview.cannotPreview') });
        return;
      }
      const stat = await this.sftp.stat(doc.path);
      this.patchDoc(id, {
        kind: 'image',
        imageSrc: `data:${mime};base64,${b64}`,
        size: stat?.size ?? 0,
        mtime: stat?.mtime ?? 0,
      });
      return;
    }

    const stat = await this.sftp.stat(doc.path);
    const text = await this.sftp.readText(doc.path, PREVIEW_MAX);
    if (text === undefined) {
      this.patchDoc(id, { kind: 'error', error: 'Lecture impossible.' });
      return;
    }
    if (text.includes('\u0000')) {
      this.patchDoc(id, { kind: 'binary', size: stat?.size ?? 0, mtime: stat?.mtime ?? 0 });
      return;
    }
    const truncated = (stat?.size ?? 0) > PREVIEW_MAX;
    if (doc.language) {
      // Prism vit dans un chunk paresseux : chargé ici, à la première
      // ouverture d'un fichier colorable, jamais au démarrage. marked suit
      // le même chemin pour les .md.
      await ensureHighlighter();
      if (doc.language === 'markdown') {
        await ensureMarkdown();
      }
    }
    const painted = this.computeHighlight(text, doc.language, true);
    this.patchDoc(id, {
      kind: 'text',
      content: text,
      original: text,
      truncated,
      readonly: truncated || this.sftp.protection() === 'readonly',
      size: stat?.size ?? text.length,
      mtime: stat?.mtime ?? 0,
      highlighted: painted.html,
      language: painted.language,
    });
  }

  setContent(value: string): void {
    const doc = this.active();
    if (!doc) {
      return;
    }
    const painted = this.computeHighlight(value, doc.language, true);
    this.patchDoc(doc.id, { content: value, highlighted: painted.html, language: painted.language });
  }

  /** Bascule entre l'éditeur et le rendu (fichiers markdown seulement). */
  setMarkdownView(rendered: boolean): void {
    const doc = this.active();
    if (doc) {
      this.patchDoc(doc.id, { markdownView: rendered });
    }
  }

  /**
   * Colorise un contenu. `measure` chronomètre la passe (à l'ouverture ET à
   * la frappe : un fichier qui passait le budget de justesse à l'ouverture
   * le crevait ensuite à chaque caractère) et abandonne la coloration
   * (language rendu null) si le fichier est trop lourd pour la cadence.
   */
  private computeHighlight(
    text: string,
    language: string | null,
    measure: boolean,
  ): { html: string | null; language: string | null } {
    if (!language || text.length > HIGHLIGHT_MAX) {
      return { html: null, language };
    }
    const timed = measure && text.length > HIGHLIGHT_MEASURE_MIN;
    const started = timed ? performance.now() : 0;
    const html = highlightCode(text, language);
    if (timed && performance.now() - started > HIGHLIGHT_BUDGET_MS) {
      return { html: null, language: null };
    }
    return { html, language };
  }

  /** Enregistre le texte sur le serveur (confirmation renforcée si protégé). */
  async save(): Promise<void> {
    const doc = this.active();
    if (!doc || !this.canSave()) {
      return;
    }
    if (this.sftp.protection() === 'confirm') {
      const host = this.sftp.host();
      const typed = await this.dialog.prompt({
        title: this.t('misc.preview.guardedSave', { name: doc.name }),
        message: `Tape « ${host} » pour confirmer l'écriture sur le serveur.`,
        placeholder: host,
        confirmLabel: 'Enregistrer',
        danger: true,
      });
      if (typed?.trim() !== host) {
        return;
      }
    }

    this._saving.set(true);

    // « Paf Prettier » : le formatage à l'enregistrement, pour les types
    // couverts, si le réglage le veut. Une erreur de syntaxe n'empêche JAMAIS
    // d'enregistrer : on écrit tel quel et on le dit.
    if (this.settings.formatOnSave()) {
      try {
        const formatted = await formatCode(doc.name, this.content());
        if (formatted !== null && formatted !== this.content()) {
          this.setContent(formatted);
        }
      } catch {
        this.toasts.info(this.t('misc.preview.savedUnformatted'), {
          detail: this.t('misc.preview.prettierFailed'),
        });
      }
    }

    try {
      const content = this.content();
      await invoke('sftp_write_text', {
        connectionId: this.sftp.connectionId(),
        path: doc.path,
        content,
      });
      this.patchDoc(doc.id, {
        original: content,
        size: content.length,
        mtime: Math.floor(Date.now() / 1000),
      });
      this.activity.log('edit', 'remote', doc.path, 'enregistré via l’aperçu');
      // Le texte à l'écran est le même avant et après : seul un bouton qui
      // s'éteint dirait que c'est parti. C'est trop peu pour une écriture sur
      // un serveur.
      this.toasts.success(this.t('misc.preview.saved'), doc.name);
      await this.sftp.refresh();
    } catch (error) {
      this.patchDoc(doc.id, { error: typeof error === 'string' ? error : String(error) });
    } finally {
      this._saving.set(false);
    }
  }

  /** Ferme le document actif (le bouton ✕ de l'en-tête). */
  close(): void {
    const id = this._activeId();
    if (id !== null) {
      void this.closeDoc(id);
    }
  }
}
