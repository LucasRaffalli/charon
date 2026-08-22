import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { CommandPalette } from '@app/components/overlays/command-palette/command-palette';
import { ContextMenu } from '@app/components/overlays/context-menu/context-menu';
import { DialogHost } from '@app/components/overlays/dialog-host/dialog-host';
import { OverwriteDialog } from '@app/components/overlays/overwrite-dialog/overwrite-dialog';
import { SettingsPanel } from '@app/components/overlays/settings-panel/settings-panel';
import { ConnectPage } from '@app/features/connect/connect-page';
import { ExplorerPage } from '@app/features/explorer/explorer-page';
import { SftpService } from '@app/services/sftp.service';
import { ModuleHostService } from '@app/services/module-host.service';
import { ThemeService } from '@app/services/theme.service';

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
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly sftp = inject(SftpService);

  // Injecté ici pour que le thème soit appliqué dès le démarrage.
  private readonly theme = inject(ThemeService);

  // Démarre l'hôte des modules dès le lancement (charge les modules actifs).
  private readonly moduleHost = inject(ModuleHostService);
}
