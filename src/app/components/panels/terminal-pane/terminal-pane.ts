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

import { SftpService } from '@app/services/connection/sftp.service';
import { TerminalService } from '@app/services/workspace/terminal.service';
import { ThemeService } from '@app/services/appearance/theme.service';

interface TermEvent {
  id: string;
  data: string;
}

/** Silence après lequel on considère que le shell a fini de démarrer. */
const OPENING_SETTLE_MS = 350;

/** Un shell resté muet ne recevra rien : mieux vaut ne pas écrire à l'aveugle. */
const OPENING_GIVE_UP_MS = 5000;

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
  private readonly terminals = inject(TerminalService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly closed = signal(false);
  protected readonly error = signal<string | null>(null);

  /**
   * Suivre le dossier de l'explorateur : le terminal va là où l'utilisateur va.
   *
   * Écrire un `cd` revient à taper dans le shell, ce qui n'est sûr que devant
   * une invite : d'où les deux gardes de `sendCd`, et ce bouton pour couper
   * franchement le suivi quand on préfère mener le terminal soi-même.
   */
  protected readonly following = signal(true);

  /** Dernier chemin envoyé, pour ne pas le renvoyer deux fois. */
  private lastSent = '';

  /**
   * Le chemin qu'on n'a pas pu envoyer : quelque chose tournait, ou une ligne
   * était en cours d'écriture. Il part dès que le shell reprend la main, et se
   * voit dans la barre en attendant pour que l'écart s'explique.
   */
  protected readonly pending = signal<string | null>(null);

  /** Caractères tapés depuis le dernier Entrée : une ligne est en cours. */
  private typed = 0;

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
    // Le suivi : chaque changement de dossier écrit un cd, tant qu'il est actif.
    effect(() => {
      const path = this.sftp.currentPath();
      if (this.following()) {
        this.sendCd(path);
      }
    });

    // « Ouvrir le terminal ici » : une demande explicite, qui aboutit même le
    // suivi coupé et même si c'est le dossier où l'on est déjà censé être.
    effect(() => {
      const jump = this.terminals.jump();
      if (jump) {
        this.sendCd(jump.path, true);
      }
    });

    this.destroyRef.onDestroy(() => {
      const id = this.terminalId;
      if (id) {
        void invoke('shell_close', { terminalId: id }).catch(() => undefined);
      }
      this.terminal?.dispose();
    });
  }

  protected toggleFollow(): void {
    const next = !this.following();
    this.following.set(next);
    if (next) {
      this.sendCd(this.sftp.currentPath());
    } else {
      this.pending.set(null);
    }
  }

  /**
   * Un programme plein écran tourne-t-il ? vim, less, htop, nano basculent tous
   * sur l'écran alternatif d'xterm : c'est le signal le plus fiable qu'on ait
   * pour savoir qu'une frappe injectée n'irait pas au shell.
   */
  private busy(): boolean {
    return this.terminal?.buffer.active.type === 'alternate' || this.typed > 0;
  }

  /**
   * Écrit un `cd` dans le shell, si le shell est en mesure de le lire.
   *
   * Le chemin passe par des quotes simples POSIX, la seule mise entre
   * guillemets dont rien ne peut s'échapper : à l'intérieur de `'…'` aucun
   * caractère n'est spécial, et une quote simple se ferme, puis s'échappe, puis
   * se rouvre. Même règle que `shell_quote` côté Rust.
   */
  private sendCd(path: string, forced = false): void {
    const terminal = this.terminal;
    const id = this.terminalId;
    if (!id || !terminal || !path || (!forced && path === this.lastSent)) {
      return;
    }
    // Le shell n'a pas encore rendu la main : la demande rejoint celle
    // d'ouverture, qui partira au bon moment. Sans ça, un « ouvrir ici » qui
    // fait naître le panneau serait écrit dans un shell qui ne lit pas encore,
    // donc perdu.
    if (this.openingCd !== null) {
      this.openingCd = path;
      return;
    }
    // Rien ne s'écrit par-dessus ce qui tourne : le chemin attend son tour.
    if (this.busy()) {
      this.pending.set(path);
      return;
    }
    this.pending.set(null);
    this.lastSent = path;
    void invoke('shell_write', {
      terminalId: id,
      data: this.cdCommand(path, terminal),
    }).catch(() => {
      // L'écriture a échoué : ne pas garder le chemin pour envoyé, sinon le
      // suivi resterait muet jusqu'au prochain dossier.
      this.lastSent = '';
    });
  }

  /**
   * La commande de déplacement, suivie de l'effacement de sa propre trace.
   *
   * Le `cd` est écrit dans le tty comme une frappe, et le tty l'écho : rien
   * côté client ne peut couper cet écho. En revanche la commande peut nettoyer
   * derrière elle. Le `printf` remonte au-dessus de la ligne échoée et efface
   * jusqu'au bas de l'écran ; le shell imprime son nouveau prompt à cet
   * endroit. Vu de l'utilisateur, le prompt s'est mis à jour sur place, sans
   * qu'une ligne ait été ajoutée.
   *
   * Le `&&` est ce qui rend la chose honnête : un `cd` qui échoue ne nettoie
   * pas, et son message d'erreur reste lisible avec la commande qui l'a causé.
   */
  private cdCommand(path: string, terminal: Terminal): string {
    const quoted = `'${path.split("'").join(`'\\''`)}'`;
    // La colonne du curseur avant l'envoi est la largeur du prompt affiché :
    // c'est elle qui décide si la ligne échoée va se replier ou non.
    const prompt = terminal.buffer.active.cursorX;
    const cols = Math.max(terminal.cols, 1);

    // Deux passes : le nombre de lignes à remonter s'écrit dans la commande,
    // donc il dépend de la longueur de celle-ci. Le nombre tenant sur un
    // chiffre, une seconde passe suffit à converger.
    const build = (rows: number): string => ` cd ${quoted} && printf '\\033[${rows}A\\033[J'`;
    let command = build(1);
    for (let pass = 0; pass < 2; pass++) {
      // Plafond de sûreté : mieux vaut laisser un résidu que remonter dans du
      // texte qui n'est pas à nous (une bannière de connexion, une sortie).
      const rows = Math.min(5, Math.floor((prompt + command.length) / cols) + 1);
      command = build(rows);
    }
    // L'espace initial garde la commande hors de l'historique quand le shell
    // est réglé pour (HIST_IGNORE_SPACE en zsh, HISTCONTROL en bash).
    return `${command}\n`;
  }

  /**
   * Le dossier où placer le terminal à son ouverture, tant qu'il n'y est pas
   * allé.
   *
   * Il ne part PAS dès que `shell_open` répond : à cet instant le shell distant
   * n'a pas fini de démarrer, il ne lit pas encore son entrée, et le tty vide
   * son tampon en cours de route. La ligne était bien échoée à l'écran, mais
   * jamais exécutée : restait un `cd … && printf …` orphelin à chaque
   * connexion, et un terminal qui n'avait pas bougé. On attend donc que le
   * shell ait parlé, puis se soit tu : son invite est affichée, il écoute.
   */
  private openingCd: string | null = null;
  private openingSettle: ReturnType<typeof setTimeout> | null = null;
  private openingGiveUp: ReturnType<typeof setTimeout> | null = null;

  /** Réarmé à chaque sortie reçue : le silence qui suit vaut « prêt ». */
  private armOpeningCd(): void {
    if (!this.openingCd) {
      return;
    }
    if (this.openingSettle) {
      clearTimeout(this.openingSettle);
    }
    this.openingSettle = setTimeout(() => {
      const path = this.openingCd;
      this.openingCd = null;
      if (path) {
        this.sendCd(path);
      }
    }, OPENING_SETTLE_MS);
  }

  /** Le shell a repris la main : le chemin en attente peut partir. */
  private flushPending(): void {
    const path = this.pending();
    if (path && this.following()) {
      this.pending.set(null);
      this.sendCd(path);
    }
  }

  /**
   * Suit ce que l'utilisateur tape, uniquement pour savoir s'il a une ligne en
   * cours d'écriture : on ne lui coupe pas sa commande au milieu.
   */
  private trackInput(data: string): void {
    for (const char of data) {
      if (char === '\r' || char === '\n' || char === '\x03') {
        // Entrée ou Ctrl+C : ligne validée ou annulée, le shell reprend la main.
        this.typed = 0;
        this.flushPending();
      } else if (char === '\x7f' || char === '\b') {
        this.typed = Math.max(0, this.typed - 1);
      } else if (char >= ' ') {
        this.typed++;
      }
    }
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
      this.trackInput(data);
      const id = this.terminalId;
      if (id) {
        void invoke('shell_write', { terminalId: id, data }).catch(() => undefined);
      }
    });

    // Sortie de vim, less ou htop : l'écran alternatif est rendu, le shell est
    // de nouveau devant nous, le chemin mis de côté peut partir.
    terminal.buffer.onBufferChange(() => {
      if (terminal.buffer.active.type === 'normal') {
        this.flushPending();
      }
    });

    const unlistenData = await listen<TermEvent>('term:data', (event) => {
      if (event.payload.id === this.terminalId) {
        terminal.write(decode(event.payload.data));
        this.armOpeningCd();
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

    // Le terminal s'ouvre là où l'utilisateur se trouve, mais pas tout de
    // suite : voir openingCd.
    // Une demande explicite déjà posée l'emporte sur le dossier de
    // l'explorateur : le panneau vient peut-être de naître d'un « ouvrir ici ».
    this.openingCd = this.terminals.jump()?.path ?? this.sftp.currentPath();
    this.openingGiveUp = setTimeout(() => (this.openingCd = null), OPENING_GIVE_UP_MS);
    this.destroyRef.onDestroy(() => {
      if (this.openingGiveUp) {
        clearTimeout(this.openingGiveUp);
      }
      if (this.openingSettle) {
        clearTimeout(this.openingSettle);
      }
    });

    terminal.focus();
  }
}
