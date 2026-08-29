import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Icon, IconName } from '@app/components/ui/icon/icon';
import { Favorite } from '@app/interfaces';
import { FavoriteEditService } from '@app/services/connection/favorite-edit.service';
import { ProfilesService } from '@app/services/connection/profiles.service';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { ContextMenuItem, ContextMenuService } from '@app/services/workspace/context-menu.service';
import { ToastService } from '@app/services/workspace/toast.service';

/** Panneau des raccourcis vers les dossiers du serveur courant. */
@Component({
  selector: 'app-favorites-pane',
  imports: [Icon],
  templateUrl: './favorites-pane.html',
  styleUrl: './favorites-pane.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FavoritesPane {
  private readonly registry = inject(SessionRegistry);
  private readonly profiles = inject(ProfilesService);
  private readonly contextMenu = inject(ContextMenuService);
  private readonly favoriteEdit = inject(FavoriteEditService);
  private readonly toasts = inject(ToastService);

  /** La session dont on montre les favoris : celle qui a le focus. */
  private get session() {
    return this.registry.focused();
  }

  protected readonly profileId = computed(() => this.registry.focused().sftp.profileId());

  protected readonly favorites = computed<Favorite[]>(() => this.profiles.favoritesOf(this.profileId()));

  /**
   * Une connexion de passage n'a pas de profil, donc nulle part où écrire ses
   * raccourcis. On le dit plutôt que d'afficher une liste vide qui laisserait
   * croire à un bug.
   */
  protected readonly hasProfile = computed(() => !!this.profileId());

  protected readonly connected = computed(() => this.registry.focused().sftp.settled());

  /** Le dossier affiché est-il déjà dans la liste ? */
  protected readonly currentIsSaved = computed(() => {
    const path = this.registry.focused().sftp.currentPath();
    return this.favorites().some((item) => item.path === path);
  });

  protected iconOf(favorite: Favorite): IconName {
    return (favorite.icon as IconName) ?? 'folder';
  }

  protected go(favorite: Favorite): void {
    void this.session.sftp.listDir(favorite.path);
  }

  /** Ajoute le dossier affiché, nommé par son dernier segment. */
  protected async addCurrent(): Promise<void> {
    const id = this.profileId();
    if (!id) {
      return;
    }
    const path = this.session.sftp.currentPath();
    const label = path.split('/').filter(Boolean).pop() ?? '/';
    if (await this.profiles.addFavorite(id, { path, label, icon: 'folder' })) {
      this.toasts.success(`« ${label} » ajouté aux favoris`, { detail: path });
    }
  }

  /** Ouvre la modale d'édition sur ce favori. */
  protected edit(favorite: Favorite): void {
    const id = this.profileId();
    if (id) {
      this.favoriteEdit.open(id, favorite);
    }
  }

  /**
   * Le clic droit ne double plus la modale : il ne garde que les deux gestes
   * qui vont plus vite au clic qu'en passant par un formulaire.
   */
  protected openMenu(event: MouseEvent, favorite: Favorite): void {
    const id = this.profileId();
    if (!id) {
      return;
    }
    const items: ContextMenuItem[] = [
      { label: 'Aller à ce dossier', icon: 'corner-up', action: () => this.go(favorite) },
      { label: 'Modifier…', icon: 'pencil', action: () => this.edit(favorite) },
      {
        label: 'Retirer des favoris',
        icon: 'trash',
        danger: true,
        action: () => void this.profiles.removeFavorite(id, favorite.path),
      },
    ];
    this.contextMenu.open(event, items);
  }
}
