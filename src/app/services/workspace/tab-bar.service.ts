import { Injectable, computed, inject } from '@angular/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import { ServerEnvironment } from '@app/interfaces';
import { ConnectionFlowService } from '@app/services/connection/connection-flow.service';
import { ProfilesService } from '@app/services/connection/profiles.service';
import { Session, SessionRegistry } from '@app/services/connection/session-registry';
import { SessionRecapService } from '@app/services/workspace/session-recap.service';

/** Un segment d'onglet : une session, son nom, son environnement, son état. */
export interface TabSegment {
  id: string;
  title: string;
  env: ServerEnvironment | null;
  active: boolean;
  /** La couleur d'identité (1..4), la même que sur les panneaux. */
  tone: number;
}

/**
 * Un onglet de la barre : une session seule, ou LA paire de la vue double,
 * fusionnée en une seule forme à segments (l'onglet dit ce que la surface
 * montre). Les segments sont à égalité : pas de serveur « choisi », le
 * clavier suit le panneau qu'on touche.
 */
export type TabItem =
  | { kind: 'single'; segment: TabSegment }
  | { kind: 'pair'; active: boolean; segments: TabSegment[] };

/**
 * La barre d'onglets de la flotte v2 : un onglet EST une session, dans la
 * page. Plus aucune fenêtre là-dessous : basculer échange des signaux, le
 * DOM des panneaux ne bouge pas, et les transferts d'une session en veille
 * continuent de courir.
 */
@Injectable({ providedIn: 'root' })
export class TabBarService {
  private readonly registry = inject(SessionRegistry);
  private readonly profiles = inject(ProfilesService);
  private readonly flow = inject(ConnectionFlowService);
  private readonly recap = inject(SessionRecapService);

  readonly tabs = computed<TabItem[]>(() => {
    const focused = this.registry.focused();
    const pair = this.registry.pair();
    const showing = this.registry.showingPair();
    const sessions = this.registry.sessions();
    const segmentOf = (session: Session, active: boolean): TabSegment => ({
      id: session.id,
      title: this.titleOf(session),
      env: session.sftp.environment(),
      active,
      tone: this.registry.toneOf(session),
    });

    const items: TabItem[] = [];
    for (const session of sessions) {
      if (pair && session.id === pair[1]) {
        continue; // déjà porté par l'onglet fusionné, à la place du premier.
      }
      if (pair && session.id === pair[0]) {
        const members = pair
          .map((id) => sessions.find((candidate) => candidate.id === id))
          .filter((candidate): candidate is Session => !!candidate);
        items.push({
          kind: 'pair',
          active: showing,
          segments: members.map((member) => segmentOf(member, showing && member === focused)),
        });
        continue;
      }
      items.push({ kind: 'single', segment: segmentOf(session, session === focused) });
    }
    return items;
  });

  /** La barre n'existe qu'à deux sessions : une session seule n'a pas d'onglet. */
  readonly visible = computed(() => this.registry.sessions().length >= 2);

  /** Nouvelle session : un onglet sur l'écran de connexion, ou directement
   *  connecté quand un profil est donné (clic droit d'un profil). */
  openTab(profileId?: string): void {
    this.registry.create();
    if (profileId) {
      const profile = this.profiles.profiles().find((candidate) => candidate.id === profileId);
      if (profile) {
        void this.flow.connectProfile(profile);
      }
    }
  }

  activate(id: string): void {
    this.registry.focus(id);
  }

  /** Pose la vue double : `left` à gauche, `right` à droite. */
  split(leftId: string, rightId: string): void {
    this.registry.split(leftId, rightId);
  }

  unsplit(): void {
    this.registry.unsplit();
  }

  /**
   * Avec qui cette session peut s'afficher côte à côte : toutes les AUTRES
   * sessions embarquées. Indépendant du focus : le menu doit proposer le
   * split quel que soit l'onglet actif au moment du clic droit.
   */
  splitCandidatesFor(id: string): Session[] {
    const self = this.registry.sessions().find((session) => session.id === id);
    if (!self?.sftp.settled()) {
      return [];
    }
    return this.registry
      .sessions()
      .filter((session) => session !== self && session.sftp.settled());
  }

  /** Le nom d'une session, tel que la barre et les vignettes l'affichent. */
  titleOf(session: Session): string {
    const profile = this.profiles
      .profiles()
      .find((candidate) => candidate.id === session.sftp.profileId());
    return profile?.name ?? (session.sftp.host() || 'Connexion');
  }

  /**
   * Ferme une session, bilan compris. La dernière session ferme la fenêtre :
   * le feu rouge et son bilan prennent alors le relais.
   */
  async closeSession(id: string): Promise<void> {
    const sessions = this.registry.sessions();
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) {
      return;
    }
    if (sessions.length <= 1) {
      void getCurrentWebviewWindow().close();
      return;
    }
    // Le bilan doit se lire devant la session qu'il raconte.
    this.registry.focus(id);
    if (session.sftp.connected()) {
      if (!(await this.recap.confirmLeave(session))) {
        return;
      }
      await session.sftp.disconnect();
    }
    this.registry.close(id);
  }

  next(): void {
    this.step(1);
  }

  previous(): void {
    this.step(-1);
  }

  private step(direction: 1 | -1): void {
    const sessions = this.registry.sessions();
    if (sessions.length < 2) {
      return;
    }
    const at = sessions.indexOf(this.registry.focused());
    this.registry.focus(sessions[(at + direction + sessions.length) % sessions.length].id);
  }

}
