import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { Icon, IconName } from '@app/components/ui/icon/icon';
import { Modal } from '@app/components/ui/modal/modal';
import { TextField } from '@app/components/ui/text-field/text-field';
import { FavoriteEditService } from '@app/services/connection/favorite-edit.service';
import { ProfilesService } from '@app/services/connection/profiles.service';
import { DialogService } from '@app/services/workspace/dialog.service';

/**
 * Les icônes proposées pour un favori. Une poignée qui couvre ce à quoi
 * servent les dossiers d'un serveur, plutôt que le registre entier : un
 * choix de cinquante icônes se parcourt au lieu de se choisir.
 */
export const FAVORITE_ICONS: readonly IconName[] = [
  'folder',
  'server',
  'terminal',
  'file-code',
  'file-config',
  'logs',
  'shield-check',
  'lock',
  'key',
  'monitor',
  'layout-grid',
  'sparkles',
];

/** La modale d'édition d'un favori : nom, icône, chemin, retrait. */
@Component({
  selector: 'app-favorite-dialog',
  imports: [Button, Icon, Modal, TextField],
  templateUrl: './favorite-dialog.html',
  styleUrl: './favorite-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FavoriteDialog {
  protected readonly edit = inject(FavoriteEditService);
  private readonly profiles = inject(ProfilesService);
  private readonly dialog = inject(DialogService);

  protected readonly icons = FAVORITE_ICONS;

  protected readonly label = signal('');
  protected readonly path = signal('');
  protected readonly icon = signal<IconName>('folder');
  protected readonly saving = signal(false);

  constructor() {
    // Le brouillon repart du favori à chaque ouverture : rouvrir la modale
    // après avoir annulé ne doit pas retrouver les modifications abandonnées.
    effect(() => {
      const state = this.edit.state();
      if (state) {
        this.label.set(state.favorite.label);
        this.path.set(state.favorite.path);
        this.icon.set((state.favorite.icon as IconName) ?? 'folder');
      }
    });
  }

  /** Un nom vide ou un chemin relatif n'est jamais enregistré. */
  protected readonly valid = computed(() => !!this.label().trim() && this.path().trim().startsWith('/'));

  protected readonly dirty = computed(() => {
    const favorite = this.edit.state()?.favorite;
    if (!favorite) {
      return false;
    }
    return this.label().trim() !== favorite.label || this.path().trim() !== favorite.path || this.icon() !== ((favorite.icon as IconName) ?? 'folder');
  });

  protected async apply(): Promise<void> {
    const state = this.edit.state();
    if (!state || !this.valid() || this.saving()) {
      return;
    }
    this.saving.set(true);
    await this.profiles.updateFavorite(state.profileId, state.favorite.path, {
      label: this.label().trim(),
      path: this.path().trim(),
      icon: this.icon(),
    });
    this.saving.set(false);
    this.edit.close();
  }

  protected async remove(): Promise<void> {
    const state = this.edit.state();
    if (!state) {
      return;
    }
    const confirmed = await this.dialog.confirm({
      title: `Retirer « ${state.favorite.label} » ?`,
      message: 'Le dossier reste sur le serveur, seul le raccourci disparaît.',
      confirmLabel: 'Retirer',
      danger: true,
    });
    if (confirmed) {
      await this.profiles.removeFavorite(state.profileId, state.favorite.path);
      this.edit.close();
    }
  }

  /** Entrée enregistre : une modale à un champ ne se valide pas à la souris. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.valid()) {
      void this.apply();
    }
  }
}
