import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { Icon } from '@app/components/ui/icon/icon';
import {
  SegmentedControl,
  SegmentedOption,
} from '@app/components/ui/segmented-control/segmented-control';
import { TextField } from '@app/components/ui/text-field/text-field';
import { UpdaterService } from '@app/services/updater.service';

/**
 * Les options avancées de la connexion : un engrenage flottant dans le coin,
 * et un popover qui se déplie depuis lui.
 *
 * Elles ne prennent aucune place dans le formulaire, qui reste court, mais
 * l'engrenage porte une pastille dès qu'une option est active ou qu'une mise à
 * jour attend, pour qu'on n'oublie ni l'une ni l'autre.
 */
@Component({
  selector: 'app-advanced-options',
  imports: [Button, Icon, SegmentedControl, TextField],
  templateUrl: './advanced-options.html',
  styleUrl: './advanced-options.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdvancedOptions {
  /** Le champ « Clé SSH » n'a de sens qu'en SFTP et en authentification par clé. */
  readonly showKeyField = input(false);

  readonly keyPath = model('');
  readonly environment = input.required<string>();
  readonly protection = input.required<string>();

  readonly environmentChange = output<string>();
  readonly protectionChange = output<string>();

  protected readonly updater = inject(UpdaterService);
  protected readonly open = signal(false);

  protected readonly environmentOptions: readonly SegmentedOption[] = [
    { value: '', label: 'Aucun' },
    { value: 'dev', label: 'Dev' },
    { value: 'staging', label: 'Staging' },
    { value: 'prod', label: 'Prod', tone: 'danger' },
  ];

  protected readonly protectionOptions: readonly SegmentedOption[] = [
    { value: '', label: 'Aucun' },
    { value: 'confirm', label: 'Confirmation' },
    { value: 'readonly', label: 'Lecture seule' },
  ];

  /** Une option est posée : l'engrenage le signale, replié ou non. */
  protected readonly hasOptions = computed(
    () => !!this.environment() || !!this.protection() || (this.showKeyField() && !!this.keyPath()),
  );

  protected readonly availableVersion = computed(() => {
    const status = this.updater.status();
    return status.kind === 'available' ? status.version : null;
  });

  /** Avancement du téléchargement, en pourcentage (null hors téléchargement). */
  protected readonly downloadPercent = computed(() => {
    const status = this.updater.status();
    if (status.kind !== 'downloading') {
      return null;
    }
    return status.total > 0 ? Math.min(100, Math.round((status.transferred / status.total) * 100)) : 0;
  });

  /** Une opération de mise à jour est en cours : relancer n'aurait pas de sens. */
  protected readonly updateBusy = computed(() => {
    const kind = this.updater.status().kind;
    return kind === 'checking' || kind === 'downloading' || kind === 'ready';
  });
}
