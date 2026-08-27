import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { highlightCode, languageFor } from '@app/services/files/code-highlight';
import { DialogService } from '@app/services/workspace/dialog.service';
import { fileIconFor } from '@app/services/files/file-icon';
import { renderMarkdown } from '@app/services/files/markdown';
import { SftpService } from '@app/services/connection/sftp.service';
import { ToastService } from '@app/services/workspace/toast.service';

export type PreviewKind = 'loading' | 'text' | 'image' | 'binary' | 'error';

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

/**
 * Aperçu / édition intégré (panneau de droite) : texte éditable enregistrable,
 * image en aperçu. SFTP uniquement. Respecte les garde-fous (lecture seule,
 * confirmation par nom d'hôte sur serveur protégé).
 */
@Injectable({ providedIn: 'root' })
export class PreviewService {
  private readonly sftp = inject(SftpService);
  private readonly dialog = inject(DialogService);
  private readonly activity = inject(ActivityLogService);
  private readonly toasts = inject(ToastService);

  private readonly _open = signal(false);
  private readonly _name = signal('');
  private readonly _path = signal('');
  private readonly _kind = signal<PreviewKind>('loading');
  private readonly _content = signal('');
  private readonly _original = signal('');
  private readonly _imageSrc = signal('');
  private readonly _readonly = signal(false);
  private readonly _truncated = signal(false);
  private readonly _saving = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _highlighted = signal<string | null>(null);
  private readonly _isMarkdown = signal(false);
  private readonly _markdownView = signal(false);

  /** Grammaire Prism du fichier ouvert (`null` = aucune coloration). */
  private language: string | null = null;

  readonly open = this._open.asReadonly();
  readonly name = this._name.asReadonly();
  readonly kind = this._kind.asReadonly();
  readonly content = this._content.asReadonly();
  readonly imageSrc = this._imageSrc.asReadonly();
  readonly readonly = this._readonly.asReadonly();
  readonly truncated = this._truncated.asReadonly();
  readonly saving = this._saving.asReadonly();
  readonly error = this._error.asReadonly();

  /** HTML Prism du contenu courant (`null` = textarea nu : langage inconnu ou fichier lourd). */
  readonly highlighted = this._highlighted.asReadonly();

  /** Icône du fichier ouvert, d'après son type. */
  readonly icon = computed(() => fileIconFor(this._name()));

  /** Le fichier ouvert est du markdown : la bascule Code/Aperçu est proposée. */
  readonly isMarkdown = this._isMarkdown.asReadonly();
  /** Aperçu markdown affiché à la place de l'éditeur. */
  readonly markdownView = this._markdownView.asReadonly();

  /** Markdown rendu, recalculé au fil des modifications. */
  readonly renderedMarkdown = computed(() =>
    this._isMarkdown() && this._markdownView() ? renderMarkdown(this._content()) : '',
  );

  readonly dirty = computed(() => this._content() !== this._original());
  readonly canSave = computed(
    () => this._kind() === 'text' && !this._readonly() && this.dirty() && !this._saving(),
  );

  /** Ouvre un fichier serveur dans le panneau d'aperçu. */
  async openFile(remotePath: string, name: string): Promise<void> {
    if (this.sftp.protocol() !== 'sftp') {
      return;
    }
    this._open.set(true);
    this._name.set(name);
    this._path.set(remotePath);
    this._kind.set('loading');
    this._content.set('');
    this._original.set('');
    this._imageSrc.set('');
    this._readonly.set(false);
    this._truncated.set(false);
    this._error.set(null);
    this._highlighted.set(null);
    this.language = languageFor(name);
    this._isMarkdown.set(this.language === 'markdown');
    // Un .md s'ouvre sur son rendu : c'est ce qu'on veut voir en premier.
    this._markdownView.set(this.language === 'markdown');

    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const mime = IMAGE_MIME[ext];
    if (mime) {
      const b64 = await invoke<string>('sftp_read_base64', {
        connectionId: this.sftp.connectionId(),
        path: remotePath,
        maxBytes: 4 * 1024 * 1024,
      }).catch(() => undefined);
      if (b64 === undefined) {
        this._kind.set('error');
        this._error.set('Aperçu impossible.');
        return;
      }
      this._imageSrc.set(`data:${mime};base64,${b64}`);
      this._kind.set('image');
      return;
    }

    const stat = await this.sftp.stat(remotePath);
    const text = await this.sftp.readText(remotePath, PREVIEW_MAX);
    if (text === undefined) {
      this._kind.set('error');
      this._error.set('Lecture impossible.');
      return;
    }
    if (text.includes('\u0000')) {
      this._kind.set('binary');
      return;
    }
    const truncated = (stat?.size ?? 0) > PREVIEW_MAX;
    this._content.set(text);
    this._original.set(text);
    this._truncated.set(truncated);
    this._readonly.set(truncated || this.sftp.protection() === 'readonly');
    this._kind.set('text');
    this.refreshHighlight(text, true);
  }

  setContent(value: string): void {
    this._content.set(value);
    this.refreshHighlight(value, false);
  }

  /** Bascule entre l'éditeur et le rendu (fichiers markdown seulement). */
  setMarkdownView(rendered: boolean): void {
    this._markdownView.set(rendered);
  }

  /**
   * Recolorise le contenu (appelé à l'ouverture puis à chaque frappe, la
   * coloration devant rester synchrone avec la saisie : le texte visible EST
   * la couche Prism). `measure` chronomètre la passe d'ouverture et abandonne
   * la coloration si le fichier est trop lourd pour tenir la cadence.
   */
  private refreshHighlight(text: string, measure: boolean): void {
    if (!this.language || text.length > HIGHLIGHT_MAX) {
      this._highlighted.set(null);
      return;
    }
    const timed = measure && text.length > HIGHLIGHT_MEASURE_MIN;
    const started = timed ? performance.now() : 0;
    const html = highlightCode(text, this.language);
    if (timed && performance.now() - started > HIGHLIGHT_BUDGET_MS) {
      this.language = null;
      this._highlighted.set(null);
      return;
    }
    this._highlighted.set(html);
  }

  /** Enregistre le texte sur le serveur (confirmation renforcée si protégé). */
  async save(): Promise<void> {
    if (!this.canSave()) {
      return;
    }
    if (this.sftp.protection() === 'confirm') {
      const host = this.sftp.host();
      const typed = await this.dialog.prompt({
        title: `Serveur protégé : enregistrer « ${this._name()} » ?`,
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
    this._error.set(null);
    try {
      await invoke('sftp_write_text', {
        connectionId: this.sftp.connectionId(),
        path: this._path(),
        content: this._content(),
      });
      this._original.set(this._content());
      this.activity.log('edit', 'remote', this._path(), 'enregistré via l’aperçu');
      // Le texte à l'écran est le même avant et après : seul un bouton qui
      // s'éteint dirait que c'est parti. C'est trop peu pour une écriture sur
      // un serveur.
      this.toasts.success('Enregistré sur le serveur', this._name());
      await this.sftp.refresh();
    } catch (error) {
      this._error.set(typeof error === 'string' ? error : String(error));
    } finally {
      this._saving.set(false);
    }
  }

  close(): void {
    this._open.set(false);
  }
}
