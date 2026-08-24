import { Injectable, computed, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import { ActivityLogService } from '@app/services/activity-log.service';
import { DialogService } from '@app/services/dialog.service';
import { SftpService } from '@app/services/sftp.service';

export type PreviewKind = 'loading' | 'text' | 'image' | 'binary' | 'error';

/** Taille max lue pour l'aperçu/édition (au-delà : aperçu tronqué en lecture seule). */
const PREVIEW_MAX = 512 * 1024;

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

  readonly open = this._open.asReadonly();
  readonly name = this._name.asReadonly();
  readonly kind = this._kind.asReadonly();
  readonly content = this._content.asReadonly();
  readonly imageSrc = this._imageSrc.asReadonly();
  readonly readonly = this._readonly.asReadonly();
  readonly truncated = this._truncated.asReadonly();
  readonly saving = this._saving.asReadonly();
  readonly error = this._error.asReadonly();

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
  }

  setContent(value: string): void {
    this._content.set(value);
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
