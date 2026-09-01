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
    const titles = this.displayTitles();

    const segmentOf = (session: Session, active: boolean): TabSegment => ({
      id: session.id,
      title: titles.get(session.id) ?? this.titleOf(session),
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

  /**
   * Plus d'une session : les raccourcis qui passent d'un onglet à l'autre
   * n'ont de sens qu'à partir de là.
   *
   * La barre, elle, est TOUJOURS affichée (voir `app.html`). Elle ne se
   * montrait qu'à deux sessions, or le bouton « + » vit dedans : la seule
   * façon d'ouvrir un deuxième onglet était donc d'en avoir déjà deux.
   */
  readonly multiple = computed(() => this.registry.sessions().length >= 2);

  /** Une seule session : le bouton d'ajout porte son libellé, il y a la place
   *  et personne n'a encore vu qu'on pouvait en ouvrir une deuxième. */
  readonly lonely = computed(() => this.registry.sessions().length < 2);
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
  /**
   * Les titres tels qu'on les AFFICHE, homonymes numérotés.
   *
   * Deux sessions ouvertes sur le même serveur portent le même nom de profil,
   * donc deux onglets rigoureusement identiques : impossible de dire lequel
   * est lequel, ni de relier un onglet au panneau qu'il gouverne. Les
   * homonymes sont donc numérotés dans l'ordre d'ouverture.
   *
   * Un numéro et pas le dossier courant : le dossier change à chaque
   * navigation, et un onglet dont le nom bouge sous les yeux ne se repère pas
   * davantage. Le numéro, lui, tient toute la vie de la session.
   *
   * Une seule table pour toute l'application : la barre d'onglets, le nom
   * porté par les panneaux du dock et les vignettes de session doivent dire
   * la même chose, sans quoi la désambiguïsation ne servirait à rien.
   */
  private readonly displayTitles = computed(() => {
    const sessions = this.registry.sessions();
    const counts = new Map<string, number>();
    for (const session of sessions) {
      const base = this.titleOf(session);
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    const titles = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const session of sessions) {
      const base = this.titleOf(session);
      if ((counts.get(base) ?? 0) < 2) {
        titles.set(session.id, base);
        continue;
      }
      const rank = (seen.get(base) ?? 0) + 1;
      seen.set(base, rank);
      titles.set(session.id, `${base} (${rank})`);
    }
    return titles;
  });

  /** Le titre affichable d'une session : `titleOf` plus le numéro d'homonyme. */
  displayTitleOf(session: Session): string {
    return this.displayTitles().get(session.id) ?? this.titleOf(session);
  }

  /** Le nom BRUT de la session : profil, hôte, ou « Connexion ». */
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
