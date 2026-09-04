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
  input,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import { SftpService } from '@app/services/connection/sftp.service';
import { Session } from '@app/services/connection/session-registry';
import { GitChip } from '@app/components/ui/git-chip/git-chip';
import {
  ContextMenuItem,
  ContextMenuService,
} from '@app/services/workspace/context-menu.service';
import { TerminalService } from '@app/services/workspace/terminal.service';
import { DockService } from '@app/services/workspace/dock.service';
import { ThemeService } from '@app/services/appearance/theme.service';
import { injectT } from '@app/lang/i18n.service';

interface TermEvent {
  id: string;
  data: string;
}

/** Silence après lequel on considère que le shell a fini de démarrer. */
const OPENING_SETTLE_MS = 350;

/** Un shell resté muet ne recevra rien : mieux vaut ne pas écrire à l'aveugle. */
const OPENING_GIVE_UP_MS = 5000;

/**
 * Après une commande tapée dans le terminal, on relit le dossier affiché dès
 * que le shell s'est tu pendant ce délai. Un `mkdir` ou un `rm` fait au
 * clavier doit se voir dans le panneau : rien ne surveille le système de
 * fichiers distant, c'est la frappe de l'utilisateur qui sert de signal.
 */
const REFRESH_SETTLE_MS = 400;

/**
 * Lignes laissées libres sous la dernière. Un terminal qui touche le bord se
 * lit mal, et surtout la ligne du prompt ne doit jamais passer sous le bord du
 * panneau : mieux vaut un peu de vide qu'une ligne coupée.
 */
const BOTTOM_MARGIN_ROWS = 1;

/** En dessous, la marge ne se prend pas : mieux vaut deux lignes serrées que
 *  rien du tout dans un panneau réduit à sa plus simple expression. */
const MIN_ROWS = 2;

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
  imports: [GitChip],
  templateUrl: './terminal-pane.html',
  styleUrl: './terminal-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalPane {
  /** LA session de ce terminal : un pane par session, le DOM et le scrollback
   *  xterm survivent aux bascules d'onglet (le pane est masqué, pas détruit). */
  readonly session = input.required<Session>();

  protected readonly t = injectT();
  private readonly contextMenu = inject(ContextMenuService);
  private readonly theme = inject(ThemeService);
  private readonly dock = inject(DockService);
  private readonly destroyRef = inject(DestroyRef);

  protected get sftp(): SftpService {
    return this.session().sftp;
  }

  private get terminals(): TerminalService {
    return this.session().terminal;
  }

  protected readonly closed = signal(false);
  /** Une relance est en cours : le bouton ne doit pas être cliqué deux fois. */
  protected readonly restarting = signal(false);
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
    afterNextRender(() => this.open());
    // Suit le thème de l'app : xterm fige ses couleurs sinon (bloc gris
    // après un changement de thème). rAF : lire les customs properties
    // APRÈS que data-theme a été appliqué au DOM.
    effect(() => {
      this.theme.theme();
      requestAnimationFrame(() => this.applyTheme());
    });
    // Fin d'un redimensionnement du dock : on recale la grille. Le
    // ResizeObserver suffit en théorie, mais il ne redéclenche pas si la
    // taille finale du glissé égale une taille déjà vue en route, et le
    // terminal resterait alors sur une grille d'un pas en arrière.
    effect(() => {
      if (!this.dock.resizing()) {
        requestAnimationFrame(() => this.refit());
      }
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
      if (this.refreshSettle) {
        clearTimeout(this.refreshSettle);
      }
      this.terminal?.dispose();
    });
  }

  /**
   * Relance un shell après un `exit` (idée 05 : le cul-de-sac).
   *
   * Jusqu'ici, la session terminée affichait « Session du terminal terminée. »
   * et rien d'autre : un `exit` tapé par réflexe condamnait l'onglet pour
   * toute la session Charon. La session SSH, elle, est toujours ouverte :
   * relancer ne coûte qu'un canal, ni reconnexion ni authentification.
   */
  protected async restart(): Promise<void> {
    const terminal = this.terminal;
    if (!terminal || this.restarting()) {
      return;
    }
    this.restarting.set(true);
    this.closed.set(false);
    this.error.set(null);
    // Le nouveau shell repart d'un écran propre, pas sous le « logout ».
    terminal.reset();
    this.terminalId = null;
    this.lastSent = '';
    this.typed = 0;
    this.pending.set(null);
    await this.startShell(terminal);
    this.restarting.set(false);
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

  /** Une commande est partie : le dossier affiché a peut-être changé. */
  private commandRan = false;
  private refreshSettle: ReturnType<typeof setTimeout> | null = null;

  /**
   * Réarmé à chaque paquet reçu : le silence qui suit vaut « la commande a
   * fini ». Une sortie continue (un `tail -f`, un build) repousse donc le
   * rafraîchissement jusqu'au calme, ce qui est exactement voulu.
   */
  private armRefresh(): void {
    if (!this.commandRan) {
      return;
    }
    if (this.refreshSettle) {
      clearTimeout(this.refreshSettle);
    }
    this.refreshSettle = setTimeout(() => {
      this.commandRan = false;
      // Pas pendant vim, less ou htop : l'écran alternatif dit qu'un programme
      // tient le tty, aucune commande n'a été validée.
      if (this.terminal?.buffer.active.type === 'alternate') {
        return;
      }
      void this.session().sftp.refreshQuietly();
      // Et l'état du dépôt : c'est le seul moment où il peut changer sans que
      // Charon en soit l'auteur, et c'est tout l'intérêt de la chose. On tape
      // `git commit` dans le terminal, la pastille suit.
      this.session().git.poke();
    }, REFRESH_SETTLE_MS);
  }

  /**
   * Le détail du dépôt : ce qui a changé, et de quoi l'ouvrir. Les entrées
   * sont des fichiers, pas des commandes : Charon ne committe ni ne pousse
   * rien à votre place. Ouvrir un fichier modifié pour le RELIRE avant de le
   * valider est en revanche exactement ce qu'on veut faire depuis là.
   */
  protected openGitMenu(event: MouseEvent): void {
    const git = this.session().git.status();
    if (!git) {
      return;
    }
    // Plafonné : un dépôt fraîchement cloné avec mille fichiers non suivis
    // ferait une liste qu'on ne parcourt pas, et un menu qui sort de l'écran.
    const shown = git.files.slice(0, 30);
    const items: ContextMenuItem[] = shown.map((file) => ({
      label: file.path,
      icon: 'file',
      danger: file.kind === 'conflicted',
      action: () => void this.openGitFile(file.path),
    }));
    if (git.files.length > shown.length) {
      items.push({ label: `et ${git.files.length - shown.length} autres…` });
    }
    this.contextMenu.open(event, [
      // Une ligne d'en-tête sans action : elle situe, elle ne se clique pas.
      { label: git.lastCommit || git.branch },
      { divider: true, label: '' },
      ...(items.length ? items : [{ label: this.t('terminal.gitClean') }]),
    ]);
  }

  /** Ouvre un fichier du dépôt dans l'aperçu, par son chemin relatif. */
  private async openGitFile(relative: string): Promise<void> {
    const git = this.session().git.status();
    if (!git) {
      return;
    }
    const root = git.root.endsWith('/') ? git.root.slice(0, -1) : git.root;
    const full = `${root}/${relative}`;
    await this.session().preview.openFile(full, relative.split('/').pop() ?? relative);
    // Ouvrir suffit rarement : ce qu'on veut voir d'un fichier listé par git,
    // c'est ce qui y a changé.
    this.session().preview.askHeadDiff();
  }

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
        // Entrée seulement : un Ctrl+C n'a rien exécuté.
        if (char !== '\x03') {
          this.commandRan = true;
        }
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
    // Les SEIZE couleurs ANSI, et pas seulement le fond et le texte.
    //
    // Elles ne sont pas décoratives : ce sont elles qui colorent `ls`, la
    // sortie de `git`, les avertissements d'un build et l'invite du serveur.
    // Tant qu'on ne les posait pas, xterm appliquait ses propres valeurs, et
    // le terminal restait le seul endroit de Charon qui parlait une autre
    // langue que le reste. Elles sont définies par thème, alignées sur la
    // palette de l'éditeur : le rouge d'une erreur au terminal est le rouge
    // d'une balise dans le code.
    terminal.options.theme = {
      background: read('--surface') ?? '#1e1e1e',
      foreground: read('--text') ?? '#d4d4d4',
      cursor: read('--accent'),
      // Le curseur d'un panneau qui n'a pas le focus se creuse au lieu de
      // clignoter : deux terminaux côte à côte, on voit lequel écoute.
      cursorAccent: read('--surface'),
      selectionBackground: read('--state-selected') ?? read('--surface-active'),
      black: read('--term-black'),
      red: read('--term-red'),
      green: read('--term-green'),
      yellow: read('--term-yellow'),
      blue: read('--term-blue'),
      magenta: read('--term-magenta'),
      cyan: read('--term-cyan'),
      white: read('--term-white'),
      brightBlack: read('--term-bright-black'),
      brightRed: read('--term-bright-red'),
      brightGreen: read('--term-bright-green'),
      brightYellow: read('--term-bright-yellow'),
      brightBlue: read('--term-bright-blue'),
      brightMagenta: read('--term-bright-magenta'),
      brightCyan: read('--term-bright-cyan'),
      brightWhite: read('--term-bright-white'),
    };
  }

  /** Le shell a-t-il été démarré (une seule fois, quand le conteneur est dimensionné) ? */
  private started = false;

  /**
   * xterm reste en import STATIQUE, à dessein.
   *
   * Le charger à la demande économisait 76 Ko de bundle initial, mais glissait
   * plusieurs dizaines de millisecondes entre `afterNextRender` et la création
   * du terminal : le ResizeObserver s'installait après la stabilisation du
   * layout (grille figée au premier calcul, PTY qui ne suivait plus la
   * hauteur) et `document.fonts.ready` pouvait être déjà résolu, désarmant le
   * garde-fou de re-mesure de police (dernière ligne rognée). L'ouverture de
   * ce panneau est une chorégraphie de mesures, elle veut du synchrone.
   */
  private open(): void {
    const element = this.host()?.nativeElement;
    if (!element || !this.sftp.connectionId() || this.sftp.protocol() !== 'sftp') {
      return;
    }

    const styles = getComputedStyle(document.documentElement);
    // La taille suit le réglage de texte de l'application : un terminal qui
    // resterait à 12 px pendant que tout le reste grossit trahirait qu'il
    // vient d'ailleurs. Bornée, parce que la grille se mesure en cellules et
    // qu'un écart trop grand rendrait le panneau inutilisable.
    const scale = Number.parseFloat(styles.getPropertyValue('--text-scale')) || 1;
    const terminal = new Terminal({
      fontSize: Math.round(Math.min(16, Math.max(10, 12 * scale))),
      fontFamily: styles.getPropertyValue('--font-mono') || 'monospace',
      // Une ligne un peu aérée : la même respiration que les listes de
      // fichiers, plutôt que le serrage par défaut d'un émulateur.
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      // Le défilement remonte loin : on relit la sortie d'un build sans
      // avoir à la relancer.
      scrollback: 5000,
      // Un mot de passe collé ou une commande multiligne arrive d'un bloc :
      // le shell sait que c'est un collage et ne l'exécute pas ligne à ligne.
      macOptionIsMeta: true,
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

  /**
   * Cale la grille sur le conteneur.
   *
   * C'est FitAddon qui mesure : il part de la taille de cellule que le moteur
   * de rendu connaît, pas de la grille courante, donc son calcul ne dérive
   * pas d'un appel à l'autre. On lui retire ensuite une ligne de marge, ce
   * qui règle du même coup le vieux défaut de la webfont (une cellule
   * légèrement sous-estimée faisait déborder la dernière ligne sous le bord).
   *
   * Piège payé le 29/08/2026 : une version maison déduisait la hauteur d'une
   * cellule en divisant la hauteur RENDUE par le nombre de lignes. Juste
   * après un redimensionnement, le DOM n'est pas encore repeint : la hauteur
   * mesurée est celle de l'ancienne grille alors que le compteur a déjà
   * changé, la cellule ressort trop grande, on retire une ligne, et le
   * terminal rétrécissait d'un cran à chaque passage.
   */
  private fitAndClamp(): void {
    const terminal = this.terminal;
    const element = this.host()?.nativeElement;
    if (!terminal || !element || element.clientHeight <= 0) {
      return; // panneau masqué : mesurer donnerait zéro ligne
    }

    this.fit.fit();

    if (terminal.rows > MIN_ROWS + BOTTOM_MARGIN_ROWS) {
      terminal.resize(terminal.cols, terminal.rows - BOTTOM_MARGIN_ROWS);
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

  /**
   * L'I/O n'est branchée qu'une fois. Une relance rouvre un canal, elle ne
   * doit pas rebrancher : deux abonnements enverraient chaque frappe en
   * double et écriraient chaque paquet reçu deux fois.
   */
  private wired = false;

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
      this.closed.set(true);
      return;
    }

    if (this.wired) {
      // Relance : le canal est neuf, les abonnements sont ceux d'origine et
      // suivent `terminalId`, qui vient de changer.
      this.openingCd = this.terminals.jump()?.path ?? this.sftp.currentPath();
      this.openingGiveUp = setTimeout(() => (this.openingCd = null), OPENING_GIVE_UP_MS);
      terminal.focus();
      return;
    }
    this.wired = true;

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
        this.armRefresh();
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
