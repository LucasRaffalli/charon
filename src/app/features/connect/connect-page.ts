import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Alert } from '@app/components/alert/alert';
import { Button } from '@app/components/button/button';
import { Drawer } from '@app/components/drawer/drawer';
import { Icon } from '@app/components/icon/icon';
import { TabItem, Tabs } from '@app/components/tabs/tabs';
import { TextField } from '@app/components/text-field/text-field';
import { ThemeSwitcher } from '@app/components/theme-switcher/theme-switcher';
import { Toggle } from '@app/components/toggle/toggle';
import { ConnectionParams, ServerProfile } from '@app/interfaces';
import { ContextMenuService } from '@app/services/context-menu.service';
import { DialogService } from '@app/services/dialog.service';
import { ProfilesService } from '@app/services/profiles.service';
import { SettingsService } from '@app/services/settings.service';
import { SftpService } from '@app/services/sftp.service';

const DEFAULT_SSH_PORT = 22;

@Component({
  selector: 'app-connect-page',
  imports: [Alert, Button, Drawer, Icon, Tabs, TextField, ThemeSwitcher, Toggle],
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

  protected readonly host = signal('');
  protected readonly port = signal(String(DEFAULT_SSH_PORT));
  protected readonly user = signal('');
  protected readonly passphrase = signal('');
  protected readonly keyPath = signal('');
  protected readonly remember = signal(false);
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

    const host = this.host().trim();
    const user = this.user().trim();
    const port = Number(this.port()) || DEFAULT_SSH_PORT;
    const passphrase = this.passphrase();
    const keyPath = this.keyPath().trim() || null;

    // Édition avec passphrase laissée vide : le backend relit celle de
    // l'ancien profil dans le trousseau via profileId.
    await this.connectWithTrust({
      host,
      port,
      user,
      keyPath,
      keyPassphrase: passphrase || null,
      profileId: passphrase ? null : this.editingId(),
    });
    if (!this.sftp.connected()) {
      return;
    }

    if (this.remember()) {
      const id = `${user}@${host}:${port}`;
      const editingId = this.editingId();

      // Édition avec identifiant changé et passphrase laissée vide : le backend
      // migre lui-même le secret du trousseau (il ne transite pas par la WebView).
      const migrateFrom = !passphrase && editingId && editingId !== id ? editingId : null;

      await this.profiles.save(
        {
          id,
          name: this.profileName().trim() || host,
          host,
          port,
          user,
          keyPath,
          hasSecret: passphrase !== '',
        },
        passphrase || null,
        migrateFrom,
      );

      if (editingId && editingId !== id) {
        await this.profiles.delete(editingId);
      }
    }
    this.editingId.set(null);
  }

  /** Précharge un profil dans le formulaire pour le modifier. */
  protected editProfile(profile: ServerProfile): void {
    this.host.set(profile.host);
    this.port.set(String(profile.port));
    this.user.set(profile.user);
    this.profileName.set(profile.name);
    this.passphrase.set('');
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
