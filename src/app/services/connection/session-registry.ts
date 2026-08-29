import {
  EnvironmentInjector,
  Injectable,
  Provider,
  Type,
  computed,
  createEnvironmentInjector,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';

import { FileClipboardService } from '@app/services/connection/file-clipboard.service';
import { SESSION_ID } from '@app/services/connection/session-token';
import { SearchService } from '@app/services/connection/search.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { SftpTreeService } from '@app/services/connection/sftp-tree.service';
import { LogTailService } from '@app/services/files/log-tail.service';
import { PermissionsService } from '@app/services/files/permissions.service';
import { PreviewService } from '@app/services/files/preview.service';
import { RemoteEditService } from '@app/services/files/remote-edit.service';
import { TransfersService } from '@app/services/files/transfers.service';
import { TrashService } from '@app/services/files/trash.service';
import { TerminalService } from '@app/services/workspace/terminal.service';

/**
 * Les services qui portent l'ÉTAT d'une session : chacun existe en un
 * exemplaire PAR session, dans son injecteur. Tout ce qui n'est pas listé ici
 * reste un singleton de fenêtre (dock, palette, raccourcis, réglages, thème,
 * panneau local, toasts, dialogues, journal).
 */
const SESSION_SERVICES: Type<unknown>[] = [
  SftpService,
  TransfersService,
  SftpTreeService,
  PreviewService,
  SearchService,
  TrashService,
  LogTailService,
  RemoteEditService,
  TerminalService,
  PermissionsService,
  FileClipboardService,
];

let NEXT_SESSION = 1;

/**
 * Une session : un serveur, et le jeu complet de ses services d'état.
 *
 * L'injecteur d'environnement enfant fait tout le travail : les services de
 * `SESSION_SERVICES` y sont fournis, donc chaque session en reçoit des
 * instances neuves, et tout composant créé avec cet injecteur (panneau
 * serveur, terminal, arbre…) résout naturellement LA session à laquelle il
 * appartient, sans changer une seule de ses injections.
 */
export class Session {
  readonly id = `s${NEXT_SESSION++}`;
  readonly injector: EnvironmentInjector;

  readonly sftp: SftpService;
  readonly transfers: TransfersService;
  readonly tree: SftpTreeService;
  readonly preview: PreviewService;
  readonly search: SearchService;
  readonly trash: TrashService;
  readonly terminal: TerminalService;
  readonly clipboard: FileClipboardService;
  readonly logTail: LogTailService;
  readonly remoteEdit: RemoteEditService;
  readonly permissions: PermissionsService;

  constructor(parent: EnvironmentInjector) {
    this.injector = createEnvironmentInjector(
      [...SESSION_SERVICES, { provide: SESSION_ID, useValue: this.id }],
      parent,
      `session-${this.id}`,
    );
    this.sftp = this.injector.get(SftpService);
    this.transfers = this.injector.get(TransfersService);
    this.tree = this.injector.get(SftpTreeService);
    this.preview = this.injector.get(PreviewService);
    this.search = this.injector.get(SearchService);
    this.trash = this.injector.get(TrashService);
    this.terminal = this.injector.get(TerminalService);
    this.clipboard = this.injector.get(FileClipboardService);
    this.logTail = this.injector.get(LogTailService);
    this.remoteEdit = this.injector.get(RemoteEditService);
    this.permissions = this.injector.get(PermissionsService);
  }

  /** Détruit l'injecteur, donc tous les services de la session (ngOnDestroy). */
  destroy(): void {
    this.injector.destroy();
  }
}

/**
 * Le registre des sessions de CETTE fenêtre, et le focus.
 *
 * Le focus n'est pas un sélecteur : c'est le dernier panneau serveur touché,
 * comme le focus de n'importe quelle app. La palette, les raccourcis, la
 * barre de statut et l'envoi depuis le panneau local parlent à la session
 * focalisée ; les panneaux de contenu (aperçu, recherche, corbeille, logs)
 * sont guidés par l'usage, jamais par un choix explicite.
 */
@Injectable({ providedIn: 'root' })
export class SessionRegistry {
  private readonly parent = inject(EnvironmentInjector);

  private readonly _sessions = signal<Session[]>([]);
  private readonly _focusedId = signal<string | null>(null);

  readonly sessions = this._sessions.asReadonly();

  constructor() {
    // L'état des onglets (focus, vue double) survit au reload : il se range
    // dans sessionStorage à chaque changement, `restore()` le relit.
    effect(() => {
      const state = {
        focused: this._focusedId(),
        pair: this._pair(),
        showingPair: this._showingPair(),
      };
      try {
        sessionStorage.setItem('charon:tabs', JSON.stringify(state));
      } catch {
        // Stockage indisponible : les onglets ne survivront pas au reload.
      }
    });

    // Un membre du split qui débarque (déconnexion volontaire, connexion
    // perdue, fermeture d'inactivité) dissout la vue double et rend le focus
    // au survivant : un panneau mort à moitié d'écran n'aide personne, et la
    // paire ne doit jamais montrer une session qui n'a plus rien à montrer.
    effect(() => {
      const pair = this._pair();
      if (!pair) {
        return;
      }
      const members = pair.map((id) => this._sessions().find((session) => session.id === id));
      if (members.every((member) => member && member.sftp.settled())) {
        return;
      }
      untracked(() => {
        const survivor = members.find((member) => member?.sftp.settled());
        this.unsplit();
        if (survivor) {
          this._focusedId.set(survivor.id);
        }
      });
    });
  }

  /**
   * La session focalisée ; à défaut, la première vivante. Jamais nulle :
   * l'App appelle `ensure()` avant le premier rendu, et fermer la dernière
   * session est interdit par `close`.
   */
  readonly focused = computed<Session>(() => {
    const sessions = this._sessions();
    const found = sessions.find((session) => session.id === this._focusedId()) ?? sessions[0];
    if (!found) {
      throw new Error('Aucune session : ensure() doit précéder tout usage.');
    }
    return found;
  });

  /**
   * La paire affichée côte à côte (vue double), et si elle est au premier
   * plan. La paire survit au passage sur un onglet simple : son onglet
   * fusionné reste dans la barre, on y revient d'un clic.
   */
  private readonly _pair = signal<[string, string] | null>(null);
  private readonly _showingPair = signal(false);
  readonly pair = this._pair.asReadonly();
  readonly showingPair = this._showingPair.asReadonly();

  /** Les sessions posées sur la surface : la paire en vue double, sinon la focalisée. */
  readonly displayed = computed<Session[]>(() => {
    const pair = this._pair();
    if (pair && this._showingPair()) {
      const sessions = pair
        .map((id) => this._sessions().find((session) => session.id === id))
        .filter((session): session is Session => !!session);
      if (sessions.length === 2) {
        return sessions;
      }
    }
    return [this.focused()];
  });

  /**
   * Pose la vue double : `left` à gauche, `right` à droite. La paire est
   * explicite et ne dépend PAS du focus : le geste vient d'un clic droit sur
   * un onglet, qui peut tomber n'importe quand, focus n'importe où.
   */
  split(leftId: string, rightId: string): void {
    const left = this._sessions().find((session) => session.id === leftId);
    const right = this._sessions().find((session) => session.id === rightId);
    // Revérifié ICI et pas seulement dans le menu : entre l'ouverture du menu
    // et le clic, une session a pu débarquer.
    if (!left || !right || left === right || !left.sftp.settled() || !right.sftp.settled()) {
      return;
    }
    this._pair.set([left.id, right.id]);
    this._showingPair.set(true);
    // Le focus rejoint la paire : sans ça, le clavier viserait une session
    // que la surface ne montre plus.
    if (!this._pair()!.includes(this._focusedId() ?? '')) {
      this._focusedId.set(right.id);
    }
  }

  /** Défait la vue double : les deux redeviennent des onglets simples. */
  unsplit(): void {
    this._pair.set(null);
    this._showingPair.set(false);
  }

  /**
   * La session dont l'aperçu est à l'écran : celle qui a ouvert un fichier en
   * DERNIER, d'où qu'elle soit : l'aperçu est guidé par l'usage, pas par le
   * focus (ouvrir un fichier du serveur B le montre, cliquer ensuite dans le
   * panneau A ne le remplace pas). À défaut, la focalisée.
   */
  readonly previewOwner = computed<Session>(() => {
    let best: Session | null = null;
    for (const session of this._sessions()) {
      if (!session.preview.open()) {
        continue;
      }
      if (!best || session.preview.openedAt() > best.preview.openedAt()) {
        best = session;
      }
    }
    return best ?? this.focused();
  });

  /**
   * La couleur d'identité d'une session (1..4, stable sur sa vie) : c'est
   * elle qui relie l'onglet, le panneau, le terminal et les transferts.
   */
  toneOf(session: Session): number {
    const n = Number.parseInt(session.id.slice(1), 10);
    return Number.isNaN(n) ? 1 : ((n - 1) % 4) + 1;
  }

  /** La première session, créée au premier besoin. Idempotent. */
  ensure(): Session {
    return this._sessions()[0] ?? this.create();
  }

  /**
   * Après un reload de la webview : recrée une session par slot sauvé
   * (`charon:session#s2`, `#s3`…), chacune se rattachant d'elle-même à SA
   * connexion du pool, qui a survécu côté Rust, puis restaure le focus et la
   * vue double. Au lancement à froid, sessionStorage est vide : une session.
   */
  restore(): void {
    this.ensure();
    let n = 2;
    while (sessionStorage.getItem(`charon:session#s${n}`)) {
      this.create();
      n++;
    }
    try {
      const raw = sessionStorage.getItem('charon:tabs');
      if (raw) {
        const saved = JSON.parse(raw) as {
          focused: string | null;
          pair: [string, string] | null;
          showingPair: boolean;
        };
        const alive = (id: string | null | undefined): boolean =>
          !!id && this._sessions().some((session) => session.id === id);
        if (saved.pair && alive(saved.pair[0]) && alive(saved.pair[1])) {
          this._pair.set(saved.pair);
          this._showingPair.set(saved.showingPair);
        }
        if (alive(saved.focused)) {
          this._focusedId.set(saved.focused);
        } else {
          this._focusedId.set(this._sessions()[0].id);
        }
      } else {
        this._focusedId.set(this._sessions()[0].id);
      }
    } catch {
      // Un état d'onglets illisible ne vaut pas un écran cassé : on repart
      // du premier onglet, comme à froid (sans ce repli, le focus resterait
      // sur la DERNIÈRE session recréée, celle du create() le plus récent).
      this._focusedId.set(this._sessions()[0].id);
    }
  }

  create(): Session {
    const session = new Session(this.parent);
    this._sessions.update((sessions) => [...sessions, session]);
    this._focusedId.set(session.id);
    return session;
  }

  focus(id: string): void {
    if (!this._sessions().some((session) => session.id === id)) {
      return;
    }
    this._focusedId.set(id);
    // Focaliser un membre de la paire ramène la vue double ; focaliser un
    // onglet simple la range (son onglet fusionné reste dans la barre).
    const pair = this._pair();
    this._showingPair.set(!!pair && pair.includes(id));
  }

  close(id: string): void {
    const session = this._sessions().find((candidate) => candidate.id === id);
    // La dernière session ne se ferme pas : `focused` garantit toujours une
    // session vivante, c'est ⌘W au niveau fenêtre qui ferme la fenêtre.
    if (!session || this._sessions().length <= 1) {
      return;
    }
    // Le partenaire de split AVANT de dissoudre : fermer un membre de la
    // paire doit rendre le focus à l'autre, pas renvoyer à la première
    // session venue.
    const pair = this._pair();
    const partnerId = pair?.includes(id) ? pair.find((member) => member !== id) : undefined;

    this._sessions.update((sessions) => sessions.filter((candidate) => candidate !== session));
    if (pair?.includes(id)) {
      this.unsplit();
    }
    if (this._focusedId() === id) {
      const remaining = this._sessions();
      const next =
        remaining.find((candidate) => candidate.id === partnerId) ??
        remaining[remaining.length - 1];
      if (next) {
        this._focusedId.set(next.id);
      }
    }
    session.destroy();
  }
}

/**
 * Le pont : chaque service d'état est fourni à la racine par une fabrique qui
 * crée la première session au premier besoin et rend SON instance. Tous les
 * `inject(SftpService)` existants continuent donc de marcher, en recevant
 * l'instance de la session, plus un singleton d'application. Les composants
 * créés plus tard avec l'injecteur d'une session (jalon 2) court-circuitent
 * ce pont, leurs providers de session passant devant la racine.
 *
 * Limite assumée : une injection par CHAMP à la racine fige l'instance de la
 * première session. Les surfaces globales qui devront suivre le focus
 * (palette, app, explorateur) lisent `registry.focused()` via des accesseurs,
 * jamais par champ.
 */
export function provideSessionServices(): Provider[] {
  return SESSION_SERVICES.map((token) => ({
    provide: token,
    useFactory: () => inject(SessionRegistry).ensure().injector.get(token),
  }));
}
