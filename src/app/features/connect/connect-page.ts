import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Alert } from '@app/components/alert/alert';
import { Button } from '@app/components/button/button';
import { Drawer } from '@app/components/drawer/drawer';
import { Icon } from '@app/components/icon/icon';
import { TabItem, Tabs } from '@app/components/tabs/tabs';
import { TextField } from '@app/components/text-field/text-field';
import { Toggle } from '@app/components/toggle/toggle';
import { ConnectionParams, RemoteProtocol, ServerEnvironment, ServerProfile } from '@app/interfaces';
import { ContextMenuService } from '@app/services/context-menu.service';
import { DialogService } from '@app/services/dialog.service';
import { ProfilesService } from '@app/services/profiles.service';
import { SettingsService } from '@app/services/settings.service';
import { SftpService } from '@app/services/sftp.service';

const DEFAULT_PORTS: Record<RemoteProtocol, number> = { sftp: 22, ftps: 21, ftp: 21 };

interface ProtocolOption {
  value: RemoteProtocol;
  label: string;
}

interface EnvironmentOption {
  value: ServerEnvironment | null;
  label: string;
}

@Component({
  selector: 'app-connect-page',
  imports: [Alert, Button, Drawer, Icon, Tabs, TextField, Toggle],
  templateUrl: './connect-page.html',
  styleUrl: './connect-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectPage {
  protected readonly sftp = inject(SftpService);
  protected readonly settings = inject(SettingsService);
  protected readonly profiles = inject(ProfilesService);
  protected readonly contextMenu = inject(ContextMenuService);
  private readonly dialog = inject(DialogService);

  protected readonly protocol = signal<RemoteProtocol>('sftp');
  protected readonly host = signal('');
  protected readonly port = signal(String(DEFAULT_PORTS.sftp));
  protected readonly user = signal('');
  protected readonly passphrase = signal('');
  protected readonly keyPath = signal('');
  protected readonly password = signal('');
  protected readonly remember = signal(false);

  protected readonly protocols: readonly ProtocolOption[] = [
    { value: 'sftp', label: 'SFTP' },
    { value: 'ftps', label: 'FTPS' },
    { value: 'ftp', label: 'FTP' },
  ];

  protected readonly environment = signal<ServerEnvironment | null>(null);
  protected readonly environments: readonly EnvironmentOption[] = [
    { value: null, label: 'Aucun' },
    { value: 'dev', label: 'Dev' },
    { value: 'staging', label: 'Staging' },
    { value: 'prod', label: 'Prod' },
  ];

  /** Position de la pastille du sélecteur d'environnement. */
  protected readonly environmentIndex = computed(() =>
    Math.max(
      0,
      this.environments.findIndex((option) => option.value === this.environment()),
    ),
  );

  /** Position de la pastille glissante du sélecteur de protocole. */
  protected readonly protocolIndex = computed(() =>
    Math.max(
      0,
      this.protocols.findIndex((option) => option.value === this.protocol()),
    ),
  );
  protected readonly profileName = signal('');
  protected readonly drawerOpen = signal(false);

  protected readonly connectTabs: TabItem[] = [
    { id: 'server', label: 'Serveur', icon: 'server' },
    { id: 'auth', label: 'Authentification', icon: 'key' },
  ];
  protected readonly activeTab = signal('server');

  /** Profil en cours d'édition via le formulaire, null sinon. */
  private readonly editingId = signal<string | null>(null);

  protected readonly canSubmit = computed(
    () => this.host().trim() !== '' && this.user().trim() !== '',
  );

  constructor() {
    void this.profiles.load();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit() || this.sftp.loading()) {
      return;
    }

    const protocol = this.protocol();
    const host = this.host().trim();
    const user = this.user().trim();
    const port = Number(this.port()) || DEFAULT_PORTS[protocol];
    const keyPath = protocol === 'sftp' ? this.keyPath().trim() || null : null;
    // Le secret saisi : passphrase de clé (SFTP) ou mot de passe (FTP/FTPS).
    const secret = protocol === 'sftp' ? this.passphrase() : this.password();

    // Édition avec secret laissé vide : le backend relit celui de
    // l'ancien profil dans le trousseau via profileId.
    await this.connectWithTrust({
      environment: this.environment(),
      protocol,
      host,
      port,
      user,
      keyPath,
      keyPassphrase: protocol === 'sftp' ? secret || null : null,
      password: protocol === 'sftp' ? null : secret || null,
      profileId: secret ? null : this.editingId(),
    });
    if (!this.sftp.connected()) {
      return;
    }

    if (this.remember()) {
      const id =
        protocol === 'sftp' ? `${user}@${host}:${port}` : `${protocol}://${user}@${host}:${port}`;
      const editingId = this.editingId();

      // Édition avec identifiant changé et secret laissé vide : le backend
      // migre lui-même le secret du trousseau (il ne transite pas par la WebView).
      const migrateFrom = !secret && editingId && editingId !== id ? editingId : null;

      await this.profiles.save(
        {
          id,
          name: this.profileName().trim() || host,
          host,
          port,
          user,
          keyPath,
          hasSecret: secret !== '',
          protocol,
          environment: this.environment(),
        },
        secret || null,
        migrateFrom,
      );

      if (editingId && editingId !== id) {
        await this.profiles.delete(editingId);
      }
    }
    this.editingId.set(null);
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
    this.environment.set(profile.environment ?? null);
    this.host.set(profile.host);
    this.port.set(String(profile.port));
    this.user.set(profile.user);
    this.profileName.set(profile.name);
    this.passphrase.set('');
    this.password.set('');
    this.keyPath.set(profile.keyPath ?? '');
    this.remember.set(true);
    this.editingId.set(profile.id);
    this.drawerOpen.set(false);
  }

  protected async connectProfile(profile: ServerProfile): Promise<void> {
    if (this.sftp.loading()) {
      return;
    }
    await this.connectWithTrust({
      environment: profile.environment ?? null,
      protocol: profile.protocol ?? 'sftp',
      host: profile.host,
      port: profile.port,
      user: profile.user,
      keyPath: profile.keyPath ?? null,
      profileId: profile.id,
    });
  }

  /**
   * Connexion avec TOFU explicite : si le serveur est inconnu, montre son
   * empreinte et ne relance la connexion qu'après accord de l'utilisateur.
   */
  private async connectWithTrust(params: ConnectionParams): Promise<void> {
    await this.sftp.connect(params);

    const fingerprint = this.sftp.pendingKey();
    if (!fingerprint) {
      return;
    }
    this.sftp.clearPendingKey();

    const trusted = await this.dialog.confirm({
      title: 'Serveur inconnu',
      message:
        `Première connexion à ${params.host}. Empreinte de la clé du serveur :\n\n` +
        `${fingerprint}\n\n` +
        `Vérifie qu'elle correspond à celle attendue avant de continuer.`,
      confirmLabel: 'Faire confiance',
    });
    if (trusted) {
      await this.sftp.connect(params, fingerprint);
      // Si l'empreinte a changé entre la confirmation et la relance,
      // on abandonne : c'est le signe d'une usurpation en cours.
      if (this.sftp.pendingKey()) {
        this.sftp.clearPendingKey();
        this.sftp.reportError(
          'La clé du serveur a changé entre deux tentatives — connexion abandonnée par prudence.',
        );
      }
    }
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
