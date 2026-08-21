import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Alert } from '@app/components/alert/alert';
import { Button } from '@app/components/button/button';
import { Drawer } from '@app/components/drawer/drawer';
import { Icon } from '@app/components/icon/icon';
import { TextField } from '@app/components/text-field/text-field';
import { ThemeSwitcher } from '@app/components/theme-switcher/theme-switcher';
import { Toggle } from '@app/components/toggle/toggle';
import { ServerProfile } from '@app/interfaces';
import { ContextMenuService } from '@app/services/context-menu.service';
import { DialogService } from '@app/services/dialog.service';
import { ProfilesService } from '@app/services/profiles.service';
import { SettingsService } from '@app/services/settings.service';
import { SftpService } from '@app/services/sftp.service';

const DEFAULT_SSH_PORT = 22;

@Component({
  selector: 'app-connect-page',
  imports: [Alert, Button, Drawer, Icon, TextField, ThemeSwitcher, Toggle],
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
  protected readonly remember = signal(false);
  protected readonly profileName = signal('');
  protected readonly drawerOpen = signal(false);

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

    await this.sftp.connect({ host, port, user, keyPassphrase: passphrase || null });
    if (!this.sftp.connected()) {
      return;
    }

    if (this.remember()) {
      const id = `${user}@${host}:${port}`;
      const editingId = this.editingId();

      // Édition avec identifiant changé et passphrase laissée vide :
      // on migre le secret existant vers le nouveau profil.
      let secret = passphrase || null;
      if (!secret && editingId && editingId !== id) {
        secret = await this.profiles.secret(editingId);
      }

      await this.profiles.save(
        {
          id,
          name: this.profileName().trim() || host,
          host,
          port,
          user,
          keyPath: null,
          hasSecret: secret !== null,
        },
        secret,
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
    this.remember.set(true);
    this.editingId.set(profile.id);
    this.drawerOpen.set(false);
  }

  protected async connectProfile(profile: ServerProfile): Promise<void> {
    if (this.sftp.loading()) {
      return;
    }
    const secret = await this.profiles.secret(profile.id);
    await this.sftp.connect({
      host: profile.host,
      port: profile.port,
      user: profile.user,
      keyPath: profile.keyPath ?? null,
      keyPassphrase: secret,
    });
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
