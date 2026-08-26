import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { getVersion } from '@tauri-apps/api/app';

import { Alert } from '@app/components/ui/alert/alert';
import { Button } from '@app/components/ui/button/button';
import { CharonGlyph } from '@app/components/brand/charon-logo/charon-glyph';
import { Icon } from '@app/components/ui/icon/icon';
import { SegmentedControl, SegmentedOption } from '@app/components/ui/segmented-control/segmented-control';
import { TextField } from '@app/components/ui/text-field/text-field';
import {
  AuthMethod,
  ConnectionParams,
  RemoteProtocol,
  ServerEnvironment,
  ServerProfile,
  ServerProtection,
} from '@app/interfaces';
import { ConnectionFlowService } from '@app/services/connection-flow.service';
import { ContextMenuService } from '@app/services/context-menu.service';
import { DialogService } from '@app/services/dialog.service';
import { ProfilesService } from '@app/services/profiles.service';
import { SftpService } from '@app/services/sftp.service';
import { UpdaterService } from '@app/services/updater.service';

const DEFAULT_PORTS: Record<RemoteProtocol, number> = { sftp: 22, ftps: 21, ftp: 21 };

/** Panneau affiché à droite : formulaire de connexion ou serveurs enregistrés. */
type Panel = 'form' | 'servers';

@Component({
  selector: 'app-connect-page',
  imports: [Alert, Button, CharonGlyph, Icon, SegmentedControl, TextField],
  templateUrl: './connect-page.html',
  styleUrl: './connect-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectPage {
  protected readonly sftp = inject(SftpService);
  protected readonly profiles = inject(ProfilesService);
  // Mise à jour accessible sans être connecté : si la connexion échoue, c'est
  // souvent la première chose qu'on veut tenter.
  protected readonly updater = inject(UpdaterService);
  protected readonly contextMenu = inject(ContextMenuService);
  private readonly dialog = inject(DialogService);
  private readonly flow = inject(ConnectionFlowService);

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
  protected readonly environmentOptions: readonly SegmentedOption[] = [
    { value: '', label: 'Aucun' },
    { value: 'dev', label: 'Dev' },
    { value: 'staging', label: 'Staging' },
    { value: 'prod', label: 'Prod', tone: 'danger' },
  ];
  /** Clé (chaîne) attendue par le SegmentedControl : null devient ''. */
  protected readonly environmentKey = computed(() => this.environment() ?? '');

  protected readonly protection = signal<ServerProtection | null>(null);
  protected readonly protectionOptions: readonly SegmentedOption[] = [
    { value: '', label: 'Aucun' },
    { value: 'confirm', label: 'Confirmation' },
    { value: 'readonly', label: 'Lecture seule' },
  ];
  protected readonly protectionKey = computed(() => this.protection() ?? '');

  protected readonly profileName = signal('');

  /** Version de l'app (affichée sur la cover), lue via l'API Tauri. */
  protected readonly version = signal('');

  /** Panneau droit courant + son switch (le libellé « Serveurs » porte le compteur). */
  protected readonly panel = signal<Panel>('form');
  protected readonly panelOptions = computed<SegmentedOption[]>(() => {
    const count = this.profiles.profiles().length;
    return [
      { value: 'form', label: 'Connexion' },
      { value: 'servers', label: count > 0 ? `Serveurs · ${count}` : 'Serveurs' },
    ];
  });
  /** Passe à true dès que l'utilisateur choisit un panneau : plus d'auto-bascule. */
  private panelPinned = false;

  /** Repli « Options avancées » (environnement + garde-fou). */
  protected readonly showAdvanced = signal(false);

  /** Profil en cours d'édition, null pour une nouvelle connexion. */
  protected readonly editingId = signal<string | null>(null);
  /** Le profil édité possédait-il déjà un secret au trousseau ? */
  private editingHadSecret = false;

  protected readonly canSubmit = computed(
    () => this.host().trim() !== '' && this.user().trim() !== '',
  );

  /** Une opération de mise à jour est en cours : relancer n'aurait pas de sens. */
  protected readonly updateBusy = computed(() => {
    const kind = this.updater.status().kind;
    return kind === 'checking' || kind === 'downloading' || kind === 'ready';
  });

  /** Formulaire visible ? (nouvelle connexion, ou édition d'un profil). */
  protected readonly showForm = computed(
    () => this.panel() === 'form' || this.editingId() !== null,
  );

  constructor() {
    void this.profiles.load();
    // Version de l'app (ignore l'échec hors contexte Tauri, ex. ng serve).
    getVersion()
      .then((v) => this.version.set(v))
      .catch(() => {});

    // Au premier chargement : s'il existe des serveurs enregistrés, ouvrir
    // directement leur liste (plus utile qu'un formulaire vide). On ne le
    // fait qu'une fois, et jamais si l'utilisateur a déjà choisi un panneau.
    effect(() => {
      const hasProfiles = this.profiles.profiles().length > 0;
      if (!this.panelPinned && hasProfiles) {
        this.panelPinned = true;
        this.panel.set('servers');
      }
    });
  }

  /** Bascule de panneau depuis le switch (fige l'auto-bascule initiale). */
  protected setPanel(panel: string): void {
    this.panelPinned = true;
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
    this.showAdvanced.set(false);
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
    this.passphrase.set('');
    this.password.set('');
    this.keyPath.set(profile.keyPath ?? '');
    this.editingId.set(profile.id);
    this.editingHadSecret = profile.hasSecret;
    // Déplier les options avancées si le profil en utilise, pour les montrer.
    this.showAdvanced.set(!!(profile.environment || profile.protection));
    // Rester dans la vue Serveurs : c'est editingId qui affiche le formulaire.
    this.panelPinned = true;
    this.panel.set('servers');
  }

  protected async connectProfile(profile: ServerProfile): Promise<void> {
    if (this.sftp.loading()) {
      return;
    }
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
