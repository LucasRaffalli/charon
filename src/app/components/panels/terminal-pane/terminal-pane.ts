import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import { SftpService } from '@app/services/sftp.service';
import { ThemeService } from '@app/services/theme.service';

interface TermEvent {
  id: string;
  data: string;
}

/** Décode la sortie base64 du backend en octets bruts pour xterm. */
const decode = (data: string): Uint8Array =>
  Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

/**
 * Terminal SSH intégré (onglet du panneau inférieur) : un shell interactif
 * sur la session déjà authentifiée — SFTP uniquement. La session survit au
 * changement d'onglet (le composant est masqué, pas détruit).
 */
@Component({
  selector: 'app-terminal-pane',
  imports: [],
  templateUrl: './terminal-pane.html',
  styleUrl: './terminal-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalPane {
  protected readonly sftp = inject(SftpService);
  private readonly theme = inject(ThemeService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly closed = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly host = viewChild<ElementRef<HTMLElement>>('term');
  private terminal: Terminal | null = null;
  private terminalId: string | null = null;
  private readonly fit = new FitAddon();

  constructor() {
    afterNextRender(() => void this.open());
    // Suit le thème de l'app : xterm fige ses couleurs sinon (bloc gris
    // après un changement de thème). rAF : lire les customs properties
    // APRÈS que data-theme a été appliqué au DOM.
    effect(() => {
      this.theme.theme();
      requestAnimationFrame(() => this.applyTheme());
    });
    this.destroyRef.onDestroy(() => {
      const id = this.terminalId;
      if (id) {
        void invoke('shell_close', { terminalId: id }).catch(() => undefined);
      }
      this.terminal?.dispose();
    });
  }

  /** Cale les couleurs d'xterm sur les custom properties du thème courant. */
  private applyTheme(): void {
    const terminal = this.terminal;
    if (!terminal) {
      return;
    }
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string): string | undefined => styles.getPropertyValue(name).trim() || undefined;
    terminal.options.theme = {
      background: read('--surface') ?? '#1e1e1e',
      foreground: read('--text') ?? '#d4d4d4',
      cursor: read('--accent'),
      selectionBackground: read('--surface-active'),
    };
  }

  private async open(): Promise<void> {
    const element = this.host()?.nativeElement;
    const connectionId = this.sftp.connectionId();
    if (!element || !connectionId || this.sftp.protocol() !== 'sftp') {
      return;
    }

    const styles = getComputedStyle(document.documentElement);
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: styles.getPropertyValue('--font-mono') || 'monospace',
      cursorBlink: true,
    });
    terminal.loadAddon(this.fit);
    terminal.open(element);
    this.fit.fit();
    this.terminal = terminal;
    this.applyTheme();

    try {
      const id = await invoke<string>('shell_open', {
        connectionId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
      this.terminalId = id;
    } catch (err) {
      this.error.set(typeof err === 'string' ? err : String(err));
      return;
    }

    terminal.onData((data) => {
      const id = this.terminalId;
      if (id) {
        void invoke('shell_write', { terminalId: id, data }).catch(() => undefined);
      }
    });

    const unlistenData = await listen<TermEvent>('term:data', (event) => {
      if (event.payload.id === this.terminalId) {
        terminal.write(decode(event.payload.data));
      }
    });
    const unlistenClosed = await listen<TermEvent>('term:closed', (event) => {
      if (event.payload.id === this.terminalId) {
        this.closed.set(true);
      }
    });
    this.destroyRef.onDestroy(() => {
      unlistenData();
      unlistenClosed();
    });

    // Suit la taille du conteneur (redimensionnement fenêtre/panneau).
    const observer = new ResizeObserver(() => {
      if (element.offsetHeight === 0) {
        return; // onglet masqué
      }
      this.fit.fit();
      const id = this.terminalId;
      if (id) {
        void invoke('shell_resize', {
          terminalId: id,
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => undefined);
      }
    });
    observer.observe(element);
    this.destroyRef.onDestroy(() => observer.disconnect());

    terminal.focus();
  }
}
