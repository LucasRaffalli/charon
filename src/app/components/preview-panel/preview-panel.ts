import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Button } from '@app/components/button/button';
import { Icon } from '@app/components/icon/icon';
import { PreviewService } from '@app/services/preview.service';

/** Panneau de droite : aperçu/édition du fichier serveur ouvert. */
@Component({
  selector: 'app-preview-panel',
  imports: [Button, Icon],
  templateUrl: './preview-panel.html',
  styleUrl: './preview-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreviewPanel {
  protected readonly preview = inject(PreviewService);
}
