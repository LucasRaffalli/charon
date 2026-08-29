import { Injectable, inject } from '@angular/core';

import { ConnectionParams, ServerProfile } from '@app/interfaces';
import { DialogService } from '@app/services/workspace/dialog.service';
import { SftpService } from '@app/services/connection/sftp.service';
import { SessionRegistry } from '@app/services/connection/session-registry';

/**
 * Flux de connexion partagé (page de connexion, command palette) :
 * connexion avec TOFU explicite : si le serveur est inconnu, montre son
 * empreinte et ne relance la connexion qu'après accord de l'utilisateur.
 */
@Injectable({ providedIn: 'root' })
export class ConnectionFlowService {
  private readonly sessionRegistry = inject(SessionRegistry);
  private readonly dialog = inject(DialogService);

  async connectWithTrust(params: ConnectionParams): Promise<void> {
    // La session est capturée au DÉBUT du flux : entre l'empreinte montrée
    // et la confirmation, l'utilisateur a pu changer d'onglet, et relire la
    // focalisée à ce moment-là relancerait la connexion sur la mauvaise
    // session.
    const sftp: SftpService = this.sessionRegistry.focused().sftp;
    await sftp.connect(params);

    const fingerprint = sftp.pendingKey();
    if (!fingerprint) {
      return;
    }
    sftp.clearPendingKey();

    const trusted = await this.dialog.confirm({
      title: 'Serveur inconnu',
      message:
        `Première connexion à ${params.host}. Empreinte de la clé du serveur :\n\n` +
        `${fingerprint}\n\n` +
        `Vérifie qu'elle correspond à celle attendue avant de continuer.`,
      confirmLabel: 'Faire confiance',
    });
    if (trusted) {
      await sftp.connect(params, fingerprint);
      // Si l'empreinte a changé entre la confirmation et la relance,
      // on abandonne : c'est le signe d'une usurpation en cours.
      if (sftp.pendingKey()) {
        sftp.clearPendingKey();
        sftp.reportError(
          'La clé du serveur a changé entre deux tentatives : connexion abandonnée par prudence.',
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
      // Dit au backend ce qu'est le secret du trousseau : passphrase ou mot de passe.
      authMethod: profile.authMethod ?? null,
      // Le dossier où ce profil dépose l'explorateur, si on lui en a posé un.
      anchor: profile.anchor ?? null,
    });
  }
}
