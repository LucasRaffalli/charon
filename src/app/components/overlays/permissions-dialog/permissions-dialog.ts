import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { Button } from '@app/components/ui/button/button';
import { Toggle } from '@app/components/ui/toggle/toggle';
import { SftpService } from '@app/services/connection/sftp.service';
import { SessionRegistry } from '@app/services/connection/session-registry';
import {
  PERM_BITS,
  PERM_CLASSES,
  PermBit,
  PermClass,
  hasPerm,
  toOctal,
  toSymbolic,
  togglePerm,
} from '@app/services/files/permissions';
import { PermissionsService } from '@app/services/files/permissions.service';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { ToastService } from '@app/services/workspace/toast.service';

const CLASS_LABELS: Record<PermClass, string> = {
  owner: 'Propriétaire',
  group: 'Groupe',
  others: 'Autres',
};

const BIT_LABELS: Record<PermBit, string> = {
  read: 'Lire',
  write: 'Écrire',
  exec: 'Exéc.',
};

/** La lettre du bouton : c'est elle qui porte l'information, pas une case. */
const BIT_LETTERS: Record<PermBit, string> = { read: 'r', write: 'w', exec: 'x' };

/** Les modes qu'on tape neuf fois sur dix, avec ce qu'ils veulent dire. */
const PRESETS: readonly { mode: string; hint: string }[] = [
  { mode: '644', hint: 'Fichier ordinaire : lisible par tous, modifiable par le propriétaire' },
  { mode: '755', hint: 'Exécutable ou dossier : parcourable par tous' },
  { mode: '600', hint: 'Privé : le propriétaire seul, pour une clé ou un .env' },
  { mode: '775', hint: 'Dossier partagé avec le groupe' },
];

/**
 * Le panneau de permissions (idée 07) : neuf cases, l'octal qui suit, et un
 * chmod qui part sur le serveur.
 *
 * Sur un serveur, les droits sont souvent la première chose qu'on regarde
 * quand quelque chose ne marche pas — et la seule qu'on ne pouvait pas voir
 * dans Charon.
 */
@Component({
  selector: 'app-permissions-dialog',
  imports: [Button, Toggle],
  templateUrl: './permissions-dialog.html',
  styleUrl: './permissions-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionsDialog {
  private readonly sessionRegistry = inject(SessionRegistry);

  protected get permissions(): PermissionsService {
    return this.sessionRegistry.focused().permissions;
  }
  private get sftp(): SftpService {
    return this.sessionRegistry.focused().sftp;
  }
  private readonly toasts = inject(ToastService);
  private readonly activity = inject(ActivityLogService);

  protected readonly classes = PERM_CLASSES;
  protected readonly bits = PERM_BITS;
  protected readonly classLabels = CLASS_LABELS;
  protected readonly bitLabels = BIT_LABELS;
  protected readonly letters = BIT_LETTERS;
  protected readonly presets = PRESETS;

  /** Le mode en cours d'édition, distinct de celui du serveur. */
  protected readonly draft = signal(0);
  protected readonly recursive = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly octal = computed(() => toOctal(this.draft()));
  protected readonly symbolic = computed(() => toSymbolic(this.draft()));

  /** Rien à appliquer tant que le brouillon égale ce que le serveur a déjà. */
  protected readonly dirty = computed(
    () => this.draft() !== (this.permissions.state()?.entry.mode ?? 0),
  );

  constructor() {
    // Ouvrir sur un autre fichier repart de SES droits, jamais du brouillon
    // laissé par le précédent.
    effect(() => {
      const request = this.permissions.state();
      this.draft.set(request?.entry.mode ?? 0);
      this.recursive.set(false);
      this.error.set(null);
    });
  }

  protected has(cls: PermClass, bit: PermBit): boolean {
    return hasPerm(this.draft(), cls, bit);
  }

  protected toggle(cls: PermClass, bit: PermBit): void {
    this.draft.update((mode) => togglePerm(mode, cls, bit));
  }

  /** Un préréglage remplace les neuf bits, en gardant les bits spéciaux. */
  protected applyPreset(mode: string): void {
    const special = this.draft() & 0o7000;
    this.draft.set(special | Number.parseInt(mode, 8));
  }

  /**
   * Entrée applique, Échap ferme : les deux réflexes d'une modale. Entrée
   * n'applique que s'il y a quelque chose à appliquer.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.permissions.close();
    } else if (event.key === 'Enter' && this.dirty() && !this.saving()) {
      event.preventDefault();
      void this.apply();
    }
  }

  protected async apply(): Promise<void> {
    const request = this.permissions.state();
    if (!request || this.saving()) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const mode = this.octal();
    try {
      await this.sftp.chmod(request.path, mode, this.recursive());
      this.activity.log(
        'rename',
        'remote',
        request.path,
        `permissions ${mode}${this.recursive() ? ' (récursif)' : ''}`,
      );
      this.toasts.success(`Permissions ${mode}`, { detail: request.entry.name });
      this.permissions.close();
      await this.sftp.refresh();
    } catch (error) {
      // Un chmod refusé est le cas courant sur un serveur : le dire sans
      // fermer, pour qu'on puisse corriger ou renoncer.
      this.error.set(typeof error === 'string' ? error : String(error));
    } finally {
      this.saving.set(false);
    }
  }
}
