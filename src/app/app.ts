import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Sparkles } from '@app/components/brand/sparkles/sparkles';
import { CommandPalette } from '@app/components/overlays/command-palette/command-palette';
import { DesignPanel } from '@app/components/overlays/design-panel/design-panel';
import { ContextMenu } from '@app/components/overlays/context-menu/context-menu';
import { DialogHost } from '@app/components/overlays/dialog-host/dialog-host';
import { OverwriteDialog } from '@app/components/overlays/overwrite-dialog/overwrite-dialog';
import { SettingsPanel } from '@app/components/overlays/settings-panel/settings-panel';
import { ConnectPage } from '@app/features/connect/connect-page';
import { ExplorerPage } from '@app/features/explorer/explorer-page';
import { SftpService } from '@app/services/sftp.service';
import { DesignService } from '@app/services/design.service';
import { ModuleHostService } from '@app/services/module-host.service';
import { SecretAccentService } from '@app/services/secret-accent.service';
import { ThemeService } from '@app/services/theme.service';
import { UpdaterService } from '@app/services/updater.service';

@Component({
  selector: 'app-root',
  imports: [
    CommandPalette,
    ConnectPage,
    ExplorerPage,
    SettingsPanel,
    DialogHost,
    OverwriteDialog,
    ContextMenu,
    DesignPanel,
    Sparkles,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly sftp = inject(SftpService);

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
