import { Injectable, inject } from '@angular/core';

import { ConnectionParams, ServerProfile } from '@app/interfaces';
import { DialogService } from '@app/services/dialog.service';
import { SftpService } from '@app/services/sftp.service';

/**
 * Flux de connexion partagé (page de connexion, command palette) :
 * connexion avec TOFU explicite — si le serveur est inconnu, montre son
 * empreinte et ne relance la connexion qu'après accord de l'utilisateur.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionFlowService {
  private readonly sftp = inject(SftpService);
  private readonly dialog = inject(DialogService);

  async connectWithTrust(params: ConnectionParams): Promise<void> {
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

  /** Connexion à un profil enregistré (secret relu du Keychain côté Rust). */
  connectProfile(profile: ServerProfile): Promise<void> {
    return this.connectWithTrust({
      environment: profile.environment ?? null,
      protection: profile.protection ?? null,
      protocol: profile.protocol ?? 'sftp',
      host: profile.host,
      port: profile.port,
      user: profile.user,
      keyPath: profile.keyPath ?? null,
      profileId: profile.id,
    });
  }
}
