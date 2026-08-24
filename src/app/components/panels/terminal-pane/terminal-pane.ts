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
 * sur la session déjà authentifiée, SFTP uniquement. La session survit au
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
        if (this.needsFontRefit) {
          this.needsFontRefit = false;
          this.remeasureFont();
        }
        this.refit();
      }
    });
    observer.observe(element);
    this.destroyRef.onDestroy(() => observer.disconnect());

    // La police mono est une webfont : si xterm ouvre avant son chargement,
    // il mesure ses cellules avec la police de secours → la grille déborde et
    // la dernière ligne est rognée. Une fois les fontes prêtes, on re-mesure,
    // mais UNIQUEMENT panneau visible : mesurer dans un conteneur masqué donne
    // des cellules de hauteur 0 (terminal invisible). Sinon, on repousse la
    // re-mesure au prochain passage visible du ResizeObserver.
    if (document.fonts.status !== 'loaded') {
      void document.fonts.ready.then(() => {
        if (!this.terminal) {
          return;
        }
        if (element.offsetHeight > 0 && element.offsetWidth > 0) {
          this.remeasureFont();
          this.refit();
        } else {
          this.needsFontRefit = true;
        }
      });
    }

    // Cas où l'élément est déjà dimensionné au montage.
    if (!this.started && element.offsetHeight > 0 && element.offsetWidth > 0) {
      this.started = true;
      void this.startShell(terminal);
    }
  }

  /** Re-mesure des fontes en attente (le panneau était masqué à leur chargement). */
  private needsFontRefit = false;

  /** Force xterm à re-mesurer ses cellules (toggle fontSize, une valeur
   *  inchangée est ignorée). À n'appeler que panneau VISIBLE. */
  private remeasureFont(): void {
    const terminal = this.terminal;
    if (!terminal) {
      return;
    }
    const size = terminal.options.fontSize ?? 12;
    terminal.options.fontSize = size + 1;
    terminal.options.fontSize = size;
  }

  /** Ajuste la grille au conteneur, puis vérifie la hauteur RÉELLEMENT rendue :
   *  si la grille déborde (mesure de police approximative, arrondi), on retire
   *  ce qu'il faut de lignes. La dernière ligne ne peut plus être cachée. */
  private fitAndClamp(): void {
    const terminal = this.terminal;
    const element = this.host()?.nativeElement;
    if (!terminal || !element) {
      return;
    }
    this.fit.fit();
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    const rendered = screen?.getBoundingClientRect().height ?? 0;
    const available = element.clientHeight;
    if (rendered > available + 1 && terminal.rows > 2) {
      // Hauteur de cellule constatée à l'écran (fonte réelle incluse).
      const cell = rendered / terminal.rows;
      const rows = Math.max(2, Math.floor(available / cell));
      if (rows < terminal.rows) {
        terminal.resize(terminal.cols, rows);
      }
    }
  }

  /** fitAndClamp + propage la nouvelle taille au PTY distant. */
  private refit(): void {
    const terminal = this.terminal;
    if (!terminal) {
      return;
    }
    this.fitAndClamp();
    const id = this.terminalId;
    if (id) {
      void invoke('shell_resize', {
        terminalId: id,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => undefined);
    }
  }

  /** Ouvre le shell SSH une fois le conteneur dimensionné, et branche l'I/O. */
  private async startShell(terminal: Terminal): Promise<void> {
    const connectionId = this.sftp.connectionId();
    if (!connectionId) {
      return;
    }
    this.fitAndClamp();
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
