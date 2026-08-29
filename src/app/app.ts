import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  untracked,
  computed,
} from '@angular/core';

import { Sparkles } from '@app/components/brand/sparkles/sparkles';
import { TabBar } from '@app/components/chrome/tab-bar/tab-bar';
import { CommandPalette } from '@app/components/overlays/command-palette/command-palette';
import { DesignPanel } from '@app/components/overlays/design-panel/design-panel';
import { ContextMenu } from '@app/components/overlays/context-menu/context-menu';
import { DialogHost } from '@app/components/overlays/dialog-host/dialog-host';
import { OverwriteDialog } from '@app/components/overlays/overwrite-dialog/overwrite-dialog';
import { PermissionsDialog } from '@app/components/overlays/permissions-dialog/permissions-dialog';
import { SessionRecap } from '@app/components/overlays/session-recap/session-recap';
import { WhatsNew } from '@app/components/overlays/whats-new/whats-new';
import { ShortcutsSheet } from '@app/components/overlays/shortcuts-sheet/shortcuts-sheet';
import { SettingsPanel } from '@app/components/overlays/settings-panel/settings-panel';
import { ToastHost } from '@app/components/overlays/toast-host/toast-host';
import { ConnectPage } from '@app/features/connect/connect-page';
import { ExplorerPage } from '@app/features/explorer/explorer-page';
import { SftpService } from '@app/services/connection/sftp.service';
import { SettingsService } from '@app/services/system/settings.service';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import { CommandPaletteService } from '@app/services/workspace/command-palette.service';
import { ProfilesService } from '@app/services/connection/profiles.service';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { ConfigSyncService } from '@app/services/system/config-sync.service';
import { ShortcutsService } from '@app/services/workspace/shortcuts.service';
import { TabBarService } from '@app/services/workspace/tab-bar.service';
import { WhatsNewService } from '@app/services/system/whats-new.service';
import { windowLabel } from '@app/services/system/window-scope';
import { DesignService } from '@app/services/appearance/design.service';
import { ModuleHostService } from '@app/services/modules/module-host.service';
import { SecretAccentService } from '@app/services/appearance/secret-accent.service';
import { ThemeService } from '@app/services/appearance/theme.service';
import { UpdaterService } from '@app/services/system/updater.service';

@Component({
  selector: 'app-root',
  imports: [
    CommandPalette,
    ConnectPage,
    ExplorerPage,
    SettingsPanel,
    DialogHost,
    OverwriteDialog,
    PermissionsDialog,
    ShortcutsSheet,
    SessionRecap,
    WhatsNew,
    ContextMenu,
    DesignPanel,
    TabBar,
    Sparkles,
    ToastHost,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Une seule écoute pour tout le clavier : le registre décide de ce qui
    // tire. Éparpiller des host listeners rendrait impossible d'en montrer la
    // liste, et deux raccourcis identiques passeraient inaperçus.
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class App {
  private readonly sessionRegistry = inject(SessionRegistry);
  protected readonly tabBar = inject(TabBarService);

  /** La session focalisée : avec une seule session, toujours elle. */
  protected get sftp(): SftpService {
    return this.sessionRegistry.focused().sftp;
  }

  /** L'explorateur vit tant qu'UNE session est embarquée, focalisée ou non. */
  protected readonly anySettled = computed(() =>
    this.sessionRegistry.sessions().some((session) => session.sftp.settled()),
  );
  // Instancié pour son effet : il fait circuler thème et réglages entre les
  // fenêtres. Personne ne l'appelle, il écoute.
  private readonly configSync = inject(ConfigSyncService);
  private readonly profiles = inject(ProfilesService);
  private readonly palette = inject(CommandPaletteService);
  private readonly shortcuts = inject(ShortcutsService);
  private readonly settings = inject(SettingsService);
  private readonly whatsNew = inject(WhatsNewService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // La première session existe avant le premier rendu, et un reload
    // recrée TOUTES les sessions sauvées (chacune se rattache à sa connexion
    // du pool, vivante côté Rust), split et focus compris.
    this.sessionRegistry.restore();

    // Le titre de la fenêtre dit la session : indispensable dès que les
    // fenêtres se regroupent en onglets natifs, qui s'appelleraient tous
    // « charon » sinon. Le nom du profil d'abord, l'hôte à défaut (une
    // connexion de passage n'a pas d'autre nom).
    effect(() => {
      const profile = this.profiles.profiles().find((p) => p.id === this.sftp.profileId());
      const session = profile?.name ?? this.sftp.host();
      const title = this.sftp.settled() && session ? session : 'Charon';
      void getCurrentWebviewWindow()
        .setTitle(title)
        .catch(() => undefined);
    });

    // Les nouveautés s'ouvrent d'elles-mêmes au premier lancement après une
    // mise à jour : c'est le seul moment où elles répondent à une question
    // qu'on se pose. La version arrive du backend, d'où l'effect.
    effect(() => {
      // La principale seulement : trois fenêtres rouvertes au lancement ne
      // doivent pas montrer trois fois les mêmes nouveautés.
      if (this.updater.currentVersion() !== '…' && windowLabel() === 'main') {
        untracked(() => this.whatsNew.showIfUpdated());
      }
    });

    this.destroyRef.onDestroy(
      this.shortcuts.register([
        {
          keys: 'mod+k',
          label: 'Palette de commandes',
          group: 'Application',
          // Doit tirer même en train de taper : c'est la porte de sortie.
          evenWhileTyping: true,
          run: () => this.palette.toggle(),
        },
        {
          keys: 'mod+/',
          label: 'Liste des raccourcis',
          group: 'Application',
          run: () => this.shortcuts.listOpen.update((open) => !open),
        },
        {
          keys: 'mod+,',
          label: 'Réglages',
          group: 'Application',
          run: () => this.settings.openPanel(),
        },
        {
          keys: 'mod+shift+w',
          label: 'Nouveautés de cette version',
          group: 'Application',
          run: () => this.whatsNew.show(),
        },
        {
          keys: 'mod+n',
          label: 'Nouvelle fenêtre',
          group: 'Application',
          run: () => void invoke('window_open', {}).catch(() => undefined),
        },
        {
          keys: 'mod+t',
          label: 'Nouvel onglet',
          group: 'Application',
          run: () => this.tabBar.openTab(),
        },
        {
          keys: 'mod+alt+arrowright',
          label: 'Onglet suivant',
          group: 'Application',
          when: () => this.tabBar.visible(),
          run: () => this.tabBar.next(),
        },
        {
          keys: 'mod+alt+arrowleft',
          label: 'Onglet précédent',
          group: 'Application',
          when: () => this.tabBar.visible(),
          run: () => this.tabBar.previous(),
        },
        {
          // ⌘W ferme LA FENÊTRE, convention macOS. Ici le cas déconnecté ;
          // connecté, l'explorateur prend la main avec le bilan de session.
          keys: 'mod+w',
          label: 'Fermer l’onglet',
          group: 'Application',
          when: () => !this.sftp.settled(),
          // Session vierge : la retirer, ou fermer la fenêtre si c'est la
          // dernière (closeSession route les deux cas).
          run: () => void this.tabBar.closeSession(this.sessionRegistry.focused().id),
        },
      ]),
    );
  }

  /**
   * Toute frappe passe par le registre. Échap ferme la liste des raccourcis
   * avant tout le reste : elle se referme comme n'importe quelle modale.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.shortcuts.listOpen()) {
      event.preventDefault();
      this.shortcuts.listOpen.set(false);
      return;
    }
    this.shortcuts.handle(event);
  }


  // Le gabarit lit l'état du mode design (position des panneaux, verrouillage).
  protected readonly design = inject(DesignService);

  // Injecté ici pour que le thème soit appliqué dès le démarrage.
  private readonly theme = inject(ThemeService);

  // Démarre l'hôte des modules dès le lancement (charge les modules actifs).
  private readonly moduleHost = inject(ModuleHostService);

  // Lance la vérification automatique des mises à jour dès le démarrage.
  private readonly updater = inject(UpdaterService);

  // Écoute le code de l'accent caché, tapé n'importe où dans l'app.
  private readonly secretAccent = inject(SecretAccentService);
}
