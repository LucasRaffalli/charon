import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';

import { Button } from '@app/components/ui/button/button';
import { AuroraSky } from '@app/components/brand/aurora-sky/aurora-sky';
import { ErrorToast } from '@app/components/overlays/error-toast/error-toast';
import { AdvancedOptions } from '@app/features/connect/advanced-options/advanced-options';
import { Traversal } from '@app/features/connect/traversal/traversal';
import { CharonGlyph } from '@app/components/brand/charon-logo/charon-glyph';
import { Icon } from '@app/components/ui/icon/icon';
import { SegmentedControl, SegmentedOption } from '@app/components/ui/segmented-control/segmented-control';
import { UpdateToast } from '@app/components/overlays/update-toast/update-toast';
import { TextField } from '@app/components/ui/text-field/text-field';
import {
  AuthMethod,
  ConnectionParams,
  RemoteProtocol,
  ServerEnvironment,
  ServerProfile,
  ServerProtection,
} from '@app/interfaces';
import { AppearanceService } from '@app/services/appearance.service';
import { ConnectionFlowService } from '@app/services/connection-flow.service';
import { ContextMenuService } from '@app/services/context-menu.service';
import { DialogService } from '@app/services/dialog.service';
import { ProfilesService } from '@app/services/profiles.service';
import { SftpService } from '@app/services/sftp.service';

const DEFAULT_PORTS: Record<RemoteProtocol, number> = { sftp: 22, ftps: 21, ftp: 21 };

/**
 * L'ouverture ne joue qu'une fois par lancement. Se déconnecter ramène ici, et
 * personne n'a envie de revoir trois secondes d'animation à ce moment-là.
 */
let introPlayed = false;

/** Étapes de l'ouverture, dans l'ordre. */
type BootPhase = 'dark' | 'lit' | 'greeting' | 'flying' | 'ready';

/** Au-delà, on considère que la séquence a échoué et on montre tout. */
const BOOT_FAILSAFE = 4500;

const BOOT_STEPS: readonly { phase: BootPhase; at: number }[] = [
  { phase: 'greeting', at: 850 },
  { phase: 'flying', at: 2350 },
  { phase: 'ready', at: 3010 },
];

/** Panneau affiché à droite : formulaire de connexion ou serveurs enregistrés. */
type Panel = 'form' | 'servers';

@Component({
  selector: 'app-connect-page',
  imports: [
    AdvancedOptions,
    AuroraSky,
    Button,
    CharonGlyph,
    ErrorToast,
    Icon,
    SegmentedControl,
    TextField,
    Traversal,
    UpdateToast,
  ],
  templateUrl: './connect-page.html',
  styleUrl: './connect-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Un geste, n'importe lequel, saute l'ouverture.
    '(document:pointerdown)': 'skipIntro()',
    '(document:keydown)': 'skipIntro()',
  },
})
export class ConnectPage implements OnDestroy {
  protected readonly sftp = inject(SftpService);
  protected readonly profiles = inject(ProfilesService);
  protected readonly contextMenu = inject(ContextMenuService);
  protected readonly appearance = inject(AppearanceService);
  private readonly dialog = inject(DialogService);
  private readonly flow = inject(ConnectionFlowService);
  private readonly document = inject(DOCUMENT);

  // --- Ouverture -----------------------------------------------------------

  private readonly introGlyph = viewChild<ElementRef<HTMLElement>>('introGlyph');
  private readonly headerGlyph = viewChild<ElementRef<HTMLElement>>('headerGlyph');

  protected readonly phase = signal<BootPhase>(introPlayed ? 'ready' : 'dark');
  protected readonly introDone = signal(introPlayed);

  /** Salut selon l'heure, et le prénom si le système veut bien le donner. */
  protected readonly userName = signal('');
  protected readonly greeting = computed(() => {
    const hour = new Date().getHours();
    const hello = hour >= 5 && hour < 18 ? 'Bonjour' : 'Bonsoir';
    const name = this.userName();
    return name ? `${hello}, ${name}.` : `${hello}.`;
  });

  /** Sous-titre : on ne dit pas « revoir » à quelqu'un qui arrive. */
  protected readonly greetingSub = computed(() =>
    this.profiles.profiles().length > 0 ? 'Heureux de vous revoir.' : 'Bienvenue à bord.',
  );

  private timers: number[] = [];
  private frames: number[] = [];


  protected readonly protocol = signal<RemoteProtocol>('sftp');
  protected readonly host = signal('');
  protected readonly port = signal(String(DEFAULT_PORTS.sftp));
  protected readonly user = signal('');
  protected readonly passphrase = signal('');
  protected readonly keyPath = signal('');
  protected readonly password = signal('');

  /** Comment on s'authentifie en SFTP. Explicite : le champ dit ce qu'il attend. */
  protected readonly authMethod = signal<AuthMethod>('key');
  protected readonly authOptions: readonly SegmentedOption[] = [
    { value: 'key', label: 'Clé SSH' },
    { value: 'password', label: 'Mot de passe' },
  ];

  /**
   * FTPS a été retiré du sélecteur : trop souvent confondu avec SFTP, alors que
   * les deux n'ont rien à voir. Le backend le gère toujours, et un profil FTPS
   * existant continue de fonctionner (l'option réapparaît si on l'édite).
   */
  protected readonly protocolOptions = computed<readonly SegmentedOption[]>(() => {
    const base: SegmentedOption[] = [
      { value: 'sftp', label: 'SFTP' },
      { value: 'ftp', label: 'FTP' },
    ];
    return this.protocol() === 'ftps' ? [base[0], { value: 'ftps', label: 'FTPS' }, base[1]] : base;
  });

  protected readonly environment = signal<ServerEnvironment | null>(null);
  /** Clé (chaîne) attendue par le SegmentedControl : null devient ''. */
  protected readonly environmentKey = computed(() => this.environment() ?? '');

  protected readonly protection = signal<ServerProtection | null>(null);
  protected readonly protectionKey = computed(() => this.protection() ?? '');

  protected readonly profileName = signal('');

  /**
   * Enregistrer un profil est un choix, pas un champ de plus : le nom
   * n'apparaît que si on le demande. En édition il est déjà là, forcément.
   */
  protected readonly namePrompted = signal(false);

  /** Version de l'app, affichée en bas à gauche. */
  protected readonly version = signal('');

  /** Où l'on embarque : affiché pendant la traversée, et à l'arrivée. */
  protected readonly destination = signal('');

  /** L'écran de traversée est à l'écran : pendant l'attente, puis à l'arrivée. */
  protected readonly traversing = computed(() => this.sftp.loading() || this.sftp.connected());

  /**
   * Les erreurs s'annoncent en carte flottante plutôt qu'en ligne dans le
   * panneau : le formulaire garde sa taille, et un échec de connexion se
   * remarque mieux qu'un texte glissé entre deux champs.
   */
  private readonly dismissedError = signal<string | null>(null);
  protected readonly visibleError = computed(() => {
    const error = this.sftp.error() ?? this.profiles.error();
    return error && error !== this.dismissedError() ? error : null;
  });

  /** Vrai dès la première bascule d'onglet : l'ouverture a sa propre cascade. */
  protected readonly switching = signal(false);

  /** Panneau droit courant + son switch (le libellé « Serveurs » porte le compteur). */
  protected readonly panel = signal<Panel>('form');
  protected readonly panelOptions = computed<SegmentedOption[]>(() => {
    const count = this.profiles.profiles().length;
    return [
      { value: 'form', label: 'Connexion' },
      { value: 'servers', label: count > 0 ? `Serveurs · ${count}` : 'Serveurs' },
    ];
  });
  /** Profil en cours d'édition, null pour une nouvelle connexion. */
  protected readonly editingId = signal<string | null>(null);
  /** Le profil édité possédait-il déjà un secret au trousseau ? */
  private editingHadSecret = false;

  protected readonly canSubmit = computed(
    () => this.host().trim() !== '' && this.user().trim() !== '',
  );

  /** Formulaire visible ? (nouvelle connexion, ou édition d'un profil). */
  protected readonly showForm = computed(
    () => this.panel() === 'form' || this.editingId() !== null,
  );

  constructor() {
    void this.profiles.load();
    this.readUserName();
    // Après le premier rendu seulement : la page doit d'abord être peinte en
    // « dark » pour que les transitions d'apparition aient un état de départ.
    afterNextRender(() => this.startIntro());

    // Et si ce rendez-vous n'a pas lieu, on ne reste pas sur un écran vide :
    // la séquence est un agrément, l'écran de connexion est la fonction.
    this.timers.push(
      setTimeout(() => {
        if (!this.introStarted) {
          this.finishIntro(false);
        }
      }, 400),
    );
    // Version de l'app (ignore l'échec hors contexte Tauri, ex. ng serve).
    getVersion()
      .then((v) => this.version.set(v))
      .catch(() => {});
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  // --- L'ouverture ---------------------------------------------------------

  /**
   * Le prénom vient du dossier personnel : son dernier segment est le nom de
   * compte du système. Rien de plus à demander au backend pour ça.
   */
  private readUserName(): void {
    invoke<string>('local_home_dir')
      .then((home) => {
        const name = home.split(/[/\\]/).filter(Boolean).pop() ?? '';
        this.userName.set(name ? name.charAt(0).toUpperCase() + name.slice(1) : '');
      })
      .catch(() => undefined);
  }

  private introStarted = false;

  private startIntro(): void {
    this.introStarted = true;
    if (introPlayed) {
      return;
    }
    introPlayed = true;

    const view = this.document.defaultView;
    const reduced = view?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
    // Fenêtre masquée : personne ne regarde, il n'y a rien à jouer.
    if (reduced || !view || this.document.hidden) {
      this.finishIntro(false);
      return;
    }

    // Si la fenêtre disparaît en cours de route, on termine tout de suite :
    // au retour l'écran doit être utilisable, pas figé au milieu d'une intro.
    const onHidden = () => {
      if (this.document.hidden && !this.introDone()) {
        this.finishIntro(false);
      }
    };
    this.document.addEventListener('visibilitychange', onHidden);
    this.cleanups.push(() => this.document.removeEventListener('visibilitychange', onHidden));

    // Une frame de plus, sinon le navigateur regroupe le passage à « lit »
    // avec le rendu initial et n'anime rien.
    this.frame(view, () => this.phase.set('lit'));

    // Filet de sécurité : quoi qu'il arrive à la séquence, l'écran ne reste
    // pas vide. Un écran de connexion invisible est bien pire qu'une intro
    // écourtée.
    this.timers.push(
      view.setTimeout(() => {
        if (!this.introDone()) {
          this.finishIntro(false);
        }
      }, BOOT_FAILSAFE),
    );

    for (const step of BOOT_STEPS) {
      this.timers.push(
        view.setTimeout(() => {
          if (step.phase === 'flying') {
            // La phase d'abord : c'est elle qui pose la transition du vol.
            // Poser la transformation avant, ce serait un saut sans animation.
            this.phase.set('flying');
            this.frame(view, () => this.flyGlyph());
          } else if (step.phase === 'ready') {
            this.finishIntro(true);
          } else {
            this.phase.set(step.phase);
          }
        }, step.at),
      );
    }
  }

  /**
   * Le glyphe du salut rejoint celui de l'en-tête. On mesure les deux et on
   * translate, plutôt que d'animer une position : le glyphe d'arrivée est déjà
   * à sa place, il est simplement invisible jusqu'à l'atterrissage.
   */
  private flyGlyph(): void {
    const from = this.introGlyph()?.nativeElement;
    const to = this.headerGlyph()?.nativeElement;
    if (!from || !to) {
      return;
    }
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    from.style.transform = `translate(${dx}px, ${dy}px) scale(${b.width / a.width})`;
  }

  /**
   * `smooth` distingue l'atterrissage naturel, où le glyphe volant est posé
   * pile sur celui de l'en-tête et autorise un fondu d'une frame, d'un saut
   * (clic, touche) où le glyphe peut être n'importe où sur sa trajectoire : le
   * montrer en double une frame serait pire que de le couper net.
   */
  private finishIntro(smooth: boolean): void {
    this.clearTimers();
    this.phase.set('ready');
    const view = this.document.defaultView;
    if (smooth && view) {
      const done = () => this.introDone.set(true);
      view.requestAnimationFrame(() => view.requestAnimationFrame(done));
      // Filet : sans frames (fenêtre masquée), on n'attend pas indéfiniment.
      this.timers.push(view.setTimeout(done, 150));
      return;
    }
    const glyph = this.introGlyph()?.nativeElement;
    if (glyph) {
      glyph.style.transform = '';
    }
    this.introDone.set(true);
  }

  /** Un geste pendant l'ouverture la saute : personne n'attend une intro. */
  protected skipIntro(): void {
    if (!this.introDone()) {
      this.finishIntro(false);
    }
  }

  /**
   * Programme un travail à la frame suivante, annulable et à l'épreuve des
   * retardataires : une frame demandée fenêtre masquée se déclenche au retour,
   * bien après la fin de l'ouverture, et remettrait la phase en arrière.
   */
  private frame(view: Window, work: () => void): void {
    this.frames.push(
      view.requestAnimationFrame(() => {
        if (!this.introDone()) {
          work();
        }
      }),
    );
  }

  private clearTimers(): void {
    const view = this.document.defaultView;
    this.timers.forEach((id) => view?.clearTimeout(id));
    this.timers = [];
    this.frames.forEach((id) => view?.cancelAnimationFrame(id));
    this.frames = [];
    this.cleanups.forEach((off) => off());
    this.cleanups = [];
  }

  private cleanups: (() => void)[] = [];

  protected promptName(): void {
    this.namePrompted.set(true);
  }

  /** Initiale du profil, pour sa vignette dans la liste. */
  protected initial(profile: ServerProfile): string {
    return (profile.name.trim()[0] ?? '?').toUpperCase();
  }

  /**
   * Ligne secondaire d'un profil : le protocole et la nature du secret. Jamais
   * l'hôte, qui n'a pas à s'afficher à l'écran de connexion.
   */
  protected meta(profile: ServerProfile): string {
    const protocol = profile.protocol ?? 'sftp';
    if (!profile.hasSecret) {
      return `${protocol} · sans secret`;
    }
    const kind = (profile.authMethod ?? 'key') === 'password' ? 'mot de passe' : 'clé';
    return `${protocol} · ${kind} au trousseau`;
  }

  /** Bascule de panneau depuis le switch (fige l'auto-bascule initiale). */
  /**
   * Annule la connexion en cours. Vraie annulation : le backend abandonne la
   * poignée de main, rien ne s'ouvre côté serveur.
   */
  protected cancelConnect(): void {
    this.sftp.cancelConnect();
  }

  protected dismissError(message: string): void {
    this.dismissedError.set(message);
  }

  protected setPanel(panel: string): void {
    this.switching.set(true);
    // Revenir à « Connexion » depuis une édition = repartir sur un formulaire vierge.
    if (panel === 'form' && this.editingId() !== null) {
      this.exitEdit();
    }
    this.panel.set(panel as Panel);
  }

  protected onProtocol(value: string): void {
    this.setProtocol(value as RemoteProtocol);
  }

  protected onEnvironment(value: string): void {
    this.environment.set((value || null) as ServerEnvironment | null);
  }

  protected onProtection(value: string): void {
    this.protection.set((value || null) as ServerProtection | null);
  }

  /** Change de méthode d'authentification et vide l'autre champ, pour qu'un
   *  secret tapé dans le mauvais mode ne parte jamais au serveur. */
  protected onAuthMethod(value: string): void {
    const next = value as AuthMethod;
    this.authMethod.set(next);
    if (next === 'key') {
      this.password.set('');
    } else {
      this.passphrase.set('');
    }
  }

  /**
   * Le secret saisi. En SFTP il dépend de la méthode choisie : passphrase de
   * clé ou mot de passe de compte. Ailleurs c'est toujours le mot de passe.
   */
  private currentSecret(): string {
    if (this.protocol() !== 'sftp') {
      return this.password();
    }
    return this.authMethod() === 'password' ? this.password() : this.passphrase();
  }

  /** Méthode d'authentification envoyée au backend (SFTP uniquement). */
  private currentAuthMethod(): AuthMethod | null {
    return this.protocol() === 'sftp' ? this.authMethod() : null;
  }

  /** Le chemin de clé n'a de sens qu'en SFTP et en authentification par clé. */
  private currentKeyPath(): string | null {
    if (this.protocol() !== 'sftp' || this.authMethod() !== 'key') {
      return null;
    }
    return this.keyPath().trim() || null;
  }

  /** Soumission du formulaire (Entrée / bouton principal). */
  protected submitForm(event: Event): void {
    event.preventDefault();
    // En édition, la soumission enregistre ; sinon elle connecte.
    if (this.editingId() !== null) {
      void this.saveEdits();
    } else {
      void this.connect();
    }
  }

  /** Se connecter (nouvelle connexion, ou bouton « Se connecter » en édition). */
  protected async connect(): Promise<void> {
    if (!this.canSubmit() || this.sftp.loading()) {
      return;
    }
    const protocol = this.protocol();
    const host = this.host().trim();
    const user = this.user().trim();
    const port = Number(this.port()) || DEFAULT_PORTS[protocol];
    const keyPath = this.currentKeyPath();
    const secret = this.currentSecret();
    this.destination.set(`${protocol}://${user ? user + '@' : ''}${host}`);

    // Secret laissé vide : le backend relit celui du profil dans le trousseau via profileId.
    await this.connectWithTrust({
      environment: this.environment(),
      protection: this.protection(),
      protocol,
      host,
      port,
      user,
      keyPath,
      keyPassphrase: protocol === 'sftp' && this.authMethod() === 'key' ? secret || null : null,
      password: protocol !== 'sftp' || this.authMethod() === 'password' ? secret || null : null,
      authMethod: this.currentAuthMethod(),
      profileId: secret ? null : this.editingId(),
    });
    if (!this.sftp.connected()) {
      return;
    }

    // On persiste si l'utilisateur le demande (nouvelle connexion) ou en édition.
    // On enregistre si un nom de profil est saisi (ou si on édite un profil).
    if (this.profileName().trim() !== '' || this.editingId() !== null) {
      await this.persistProfile();
    }
    this.exitEdit();
  }

  /** Enregistre les modifications du profil sans se connecter (mode édition). */
  protected async saveEdits(): Promise<void> {
    if (!this.canSubmit() || this.sftp.loading()) {
      return;
    }
    await this.persistProfile();
    this.exitEdit(); // retour à la liste des serveurs
  }

  /** Écrit le profil courant dans le store (+ trousseau), avec migration au besoin. */
  private async persistProfile(): Promise<void> {
    const protocol = this.protocol();
    const host = this.host().trim();
    const user = this.user().trim();
    const port = Number(this.port()) || DEFAULT_PORTS[protocol];
    const keyPath = this.currentKeyPath();
    const secret = this.currentSecret();
    const id =
      protocol === 'sftp' ? `${user}@${host}:${port}` : `${protocol}://${user}@${host}:${port}`;
    const editingId = this.editingId();

    // Identifiant changé + secret laissé vide : le backend migre lui-même le
    // secret du trousseau (il ne transite jamais par la WebView).
    const migrateFrom = !secret && editingId && editingId !== id ? editingId : null;

    await this.profiles.save(
      {
        id,
        name: this.profileName().trim() || host,
        host,
        port,
        user,
        keyPath,
        // Secret laissé vide en édition = on garde celui déjà stocké.
        hasSecret: secret !== '' || this.editingHadSecret,
        protocol,
        environment: this.environment(),
        protection: this.protection(),
        // Indispensable : sans ça, le backend relirait un mot de passe stocké
        // comme s'il s'agissait d'une passphrase de clé.
        authMethod: this.currentAuthMethod(),
      },
      secret || null,
      migrateFrom,
    );

    if (editingId && editingId !== id) {
      await this.profiles.delete(editingId);
    }
  }

  /** Annule l'édition et revient à la liste des serveurs. */
  protected cancelEdit(): void {
    this.exitEdit();
  }

  /** Quitte le mode édition et remet le formulaire à zéro. */
  private exitEdit(): void {
    this.editingId.set(null);
    this.editingHadSecret = false;
    this.resetForm();
  }

  /** Réinitialise tous les champs du formulaire. */
  private resetForm(): void {
    this.protocol.set('sftp');
    this.authMethod.set('key');
    this.host.set('');
    this.port.set(String(DEFAULT_PORTS.sftp));
    this.user.set('');
    this.passphrase.set('');
    this.keyPath.set('');
    this.password.set('');
    this.environment.set(null);
    this.protection.set(null);
    this.profileName.set('');
    this.namePrompted.set(false);
  }

  /** Change de protocole en ajustant le port s'il était celui par défaut. */
  protected setProtocol(next: RemoteProtocol): void {
    const previous = this.protocol();
    if (next === previous) {
      return;
    }
    if (this.port() === String(DEFAULT_PORTS[previous]) || this.port() === '') {
      this.port.set(String(DEFAULT_PORTS[next]));
    }
    this.protocol.set(next);
  }

  /** Précharge un profil dans le formulaire pour le modifier. */
  protected editProfile(profile: ServerProfile): void {
    this.protocol.set(profile.protocol ?? 'sftp');
    this.authMethod.set(profile.authMethod ?? 'key');
    this.environment.set(profile.environment ?? null);
    this.protection.set(profile.protection ?? null);
    this.host.set(profile.host);
    this.port.set(String(profile.port));
    this.user.set(profile.user);
    this.profileName.set(profile.name);
    this.namePrompted.set(true);
    this.passphrase.set('');
    this.password.set('');
    this.keyPath.set(profile.keyPath ?? '');
    this.editingId.set(profile.id);
    this.editingHadSecret = profile.hasSecret;
    // Rester dans la vue Serveurs : c'est editingId qui affiche le formulaire.
    this.panel.set('servers');
  }

  protected async connectProfile(profile: ServerProfile): Promise<void> {
    if (this.sftp.loading()) {
      return;
    }
    this.destination.set(profile.name);
    await this.flow.connectProfile(profile);
  }

  /** Connexion avec TOFU explicite, flux partagé avec la command palette. */
  private connectWithTrust(params: ConnectionParams): Promise<void> {
    return this.flow.connectWithTrust(params);
  }

  protected removeProfile(profile: ServerProfile): void {
    void this.profiles.delete(profile.id);
  }

  protected openProfileMenu(event: MouseEvent, profile: ServerProfile): void {
    this.contextMenu.open(event, [
      {
        label: 'Se connecter',
        icon: 'chevron-right',
        action: () => void this.connectProfile(profile),
      },
      { label: 'Modifier…', icon: 'edit', action: () => this.editProfile(profile) },
      { label: 'Renommer…', icon: 'pencil', action: () => void this.renameProfile(profile) },
      {
        label: 'Supprimer',
        icon: 'trash',
        danger: true,
        action: () => this.removeProfile(profile),
      },
    ]);
  }

  private async renameProfile(profile: ServerProfile): Promise<void> {
    const name = (
      await this.dialog.prompt({
        title: `Renommer « ${profile.name} »`,
        value: profile.name,
        confirmLabel: 'Renommer',
      })
    )?.trim();
    if (name && name !== profile.name) {
      // secret: null = le secret du trousseau reste tel quel.
      await this.profiles.save({ ...profile, name }, null);
    }
  }
}
