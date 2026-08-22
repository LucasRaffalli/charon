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

  /** Le shell a-t-il été démarré (une seule fois, quand le conteneur est dimensionné) ? */
  private started = false;

  private open(): void {
    const element = this.host()?.nativeElement;
    if (!element || !this.sftp.connectionId() || this.sftp.protocol() !== 'sftp') {
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
    this.terminal = terminal;
    this.applyTheme();

    // Le shell ne démarre qu'une fois le conteneur réellement dimensionné :
    // xterm ouvert dans un conteneur 0×0 (onglet pas encore visible) produit
    // un PTY invalide → terminal vide. Le ResizeObserver pilote le démarrage
    // puis les redimensionnements. Il émet un premier callback à l'observation.
    const observer = new ResizeObserver(() => {
      if (element.offsetHeight === 0 || element.offsetWidth === 0) {
        return; // masqué / pas encore dimensionné
      }
      if (!this.started) {
        this.started = true;
        void this.startShell(terminal);
      } else {
        this.fit.fit();
        const id = this.terminalId;
        if (id) {
          void invoke('shell_resize', {
            terminalId: id,
            cols: terminal.cols,
            rows: terminal.rows,
          }).catch(() => undefined);
        }
      }
    });
    observer.observe(element);
    this.destroyRef.onDestroy(() => observer.disconnect());

    // Cas où l'élément est déjà dimensionné au montage.
    if (!this.started && element.offsetHeight > 0 && element.offsetWidth > 0) {
      this.started = true;
      void this.startShell(terminal);
    }
  }

  /** Ouvre le shell SSH une fois le conteneur dimensionné, et branche l'I/O. */
  private async startShell(terminal: Terminal): Promise<void> {
    const connectionId = this.sftp.connectionId();
    if (!connectionId) {
      return;
    }
    this.fit.fit();
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

    terminal.focus();
  }
}
