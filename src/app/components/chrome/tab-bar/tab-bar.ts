import { DOCUMENT } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import { Icon } from '@app/components/ui/icon/icon';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { shortcutSymbols } from '@app/services/workspace/shortcuts.service';
import { ContextMenuService } from '@app/services/workspace/context-menu.service';
import { TabBarService, TabItem, TabSegment } from '@app/services/workspace/tab-bar.service';
import { injectT } from '@app/lang/i18n.service';

/** Au-delà de ce déplacement, c'est un glissé et plus un clic. Même seuil que
 *  partout ailleurs dans l'application. */
const DRAG_THRESHOLD = 5;

/**
 * La barre d'onglets. Un onglet est une SESSION dans la page (flotte v2), et
 * les deux sessions de la vue double fusionnent en UN onglet à segments :
 * l'onglet dit ce que la surface montre. La barre sert aussi de zone de
 * saisie de la fenêtre (`data-tauri-drag-region` sur le fond seulement).
 */
@Component({
  selector: 'app-tab-bar',
  imports: [Icon],
  templateUrl: './tab-bar.html',
  styleUrl: './tab-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabBar {
  private readonly t = injectT();
  protected readonly tabBar = inject(TabBarService);
  private readonly registry = inject(SessionRegistry);
  private readonly contextMenu = inject(ContextMenuService);
  private readonly destroyRef = inject(DestroyRef);

  protected trackOf(tab: TabItem): string {
    return tab.kind === 'single' ? tab.segment.id : 'pair';
  }

  // --- Réordonner les onglets ------------------------------------------------
  //
  // En événements POINTEUR, comme le glissé de fichiers et celui du dock : le
  // drag HTML5 ne fonctionne pas dans la webview (le handler natif de Tauri
  // avale `dragover`/`drop`). Le seuil de 5 px protège le clic, et l'onglet
  // suivi ne bouge pas lui-même : c'est un TRAIT qui dit où il se posera, ce
  // qui évite de faire sauter la barre sous le curseur.

  /** L'onglet saisi, tant que le seuil n'est pas franchi. */
  private pending: { id: string; x: number; fromSegment: boolean } | null = null;
  /**
   * Le glissé a-t-il commencé sur UNE moitié d'un onglet fusionné ?
   *
   * Les deux gestes portent le même identifiant de session, et pourtant ils
   * ne veulent pas dire la même chose : tirer l'onglet entier le déplace en
   * restant fusionné, tirer une moitié la sort de la paire. Sans ce drapeau,
   * réordonner une vue double la défaisait.
   */
  private fromSegment = false;
  /** Le rang d'insertion visé, ou `null` hors glissé. */
  /**
   * Le libellé et l'infobulle du bouton d'ajout, raccourci compris. Un geste
   * qui n'existe qu'au clavier doit être écrit quelque part, sinon il n'existe
   * que pour ceux qui le connaissent déjà.
   */
  private readonly mac = /mac/i.test(navigator.platform || navigator.userAgent);
  protected readonly newTabLabel = computed(() => this.t('app.newTab'));
  protected readonly newTabTitle = computed(
    () => `${this.t('app.newTab')} (${shortcutSymbols('mod+t', this.mac).join('')})`,
  );

  protected readonly insertAt = signal<number | null>(null);

  /**
   * L'onglet sur lequel le glissé se poserait pour FUSIONNER, c'est-à-dire
   * ouvrir les deux sessions côte à côte.
   *
   * Le vocabulaire est celui du dock, et c'est délibéré : on y glisse déjà un
   * onglet de panneau au CENTRE d'un groupe pour l'y ranger, ou sur un BORD
   * pour couper. Les sessions répondent pareil, centre pour réunir, bord pour
   * déplacer. Un seul geste à apprendre pour les deux barres.
   */
  protected readonly mergeOnto = signal<string | null>(null);

  /**
   * L'onglet en cours de déplacement. En signal et non en champ nu : le
   * gabarit s'en sert pour l'estomper, et il n'y a pas de retour visuel sans
   * ça. Sans savoir ce qu'on tient, on ne sait pas non plus qu'on tient
   * quelque chose.
   */
  protected readonly draggingId = signal<string | null>(null);

  protected onTabPointerDown(event: PointerEvent, id: string, fromSegment = false): void {
    if (event.button !== 0) {
      return;
    }
    this.pending = { id, x: event.clientX, fromSegment };
    // Pas de capture ICI, elle est posée au franchissement du seuil (voir
    // `onTabPointerMove`).
  }

  protected onTabPointerMove(event: PointerEvent): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    if (!this.draggingId()) {
      if (Math.abs(event.clientX - pending.x) < DRAG_THRESHOLD) {
        return;
      }
      // Le pointeur est capturé MAINTENANT, et pas au `pointerdown`.
      //
      // Sans capture du tout, les événements cessent d'être livrés dès que le
      // curseur quitte l'onglet : le geste meurt en silence, et réordonner ne
      // marche pas. Capturée trop tôt, en revanche, elle recible le clic vers
      // l'élément capturant, et la croix de fermeture nichée dans l'onglet
      // activerait la session au lieu de la fermer. Le seuil est le seul
      // moment juste : à partir de là c'est un glissé, plus un clic. Même
      // règle que le glissé de fichiers, où la leçon a déjà été payée.
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      this.draggingId.set(pending.id);
      this.fromSegment = pending.fromSegment;
      this.document.body.classList.add('is-dock-dragging');
    }
    this.aimAt(event.clientX);
  }

  /**
   * Où le lâcher tomberait : sur le centre d'un autre onglet (fusion), ou
   * entre deux onglets (déplacement).
   *
   * L'onglet est coupé en TIERS, un pour chaque geste de part et d'autre du
   * tiers central. La bande centrale valait d'abord la moitié, et c'était
   * trop : avec deux onglets, viser un déplacement revenait à toucher un
   * quart de largeur, et réordonner passait pour cassé. Un geste ajouté ne
   * doit pas manger celui qui était là avant.
   */
  private aimAt(x: number): void {
    const target = this.mergeTargetAt(x);
    this.mergeOnto.set(target);
    this.insertAt.set(target ? null : this.indexAt(x));
  }

  /**
   * L'onglet fusionnable sous ce point, s'il y en a un.
   *
   * Refusé sur soi-même, et sur un onglet DÉJÀ fusionné : la vue double tient
   * deux sessions, pas trois. Refusé aussi si l'une des deux n'est pas
   * embarquée, `split` l'exigeant : une moitié d'écran montrant un écran de
   * connexion n'aiderait personne.
   */
  private mergeTargetAt(x: number): string | null {
    const dragged = this.draggingId();
    if (!dragged) {
      return null;
    }
    const tabs = Array.from(
      this.document.querySelectorAll<HTMLElement>('.bar [data-tab-first]'),
    );
    for (const tab of tabs) {
      const rect = tab.getBoundingClientRect();
      if (x < rect.left || x > rect.right) {
        continue;
      }
      if (x < rect.left + rect.width / 3 || x > rect.right - rect.width / 3) {
        return null;
      }
      if (tab.classList.contains('tab--duo')) {
        return null;
      }
      // Ce qu'on traîne est DÉJÀ une paire : la fusionner avec une troisième
      // session ferait sortir sa seconde moitié sans qu'on l'ait demandé. Un
      // onglet fusionné se déplace, il ne se refusionne pas.
      if (this.registry.pair()?.includes(dragged)) {
        return null;
      }
      const id = tab.dataset['tabFirst'];
      return id && id !== dragged && this.registry.canSplit(dragged, id) ? id : null;
    }
    return null;
  }

  protected onTabPointerUp(): void {
    const dragged = this.draggingId();
    const index = this.insertAt();
    const merge = this.mergeOnto();
    // Lu AVANT `stopDrag`, qui remet l'état du geste à zéro.
    const pulledOut = this.fromSegment;
    this.stopDrag();
    if (!dragged) {
      return;
    }
    if (merge) {
      // Paire EXPLICITE, comme l'entrée « Côte à côte avec » du menu : elle ne
      // dépend pas de la session focalisée, qui n'est pas forcément l'une des
      // deux qu'on vient de réunir.
      this.registry.split(dragged, merge);
      return;
    }
    // Sortir une session de la paire : le geste inverse de la fusion, et le
    // même qu'au dock, où l'on tire un onglet hors de son groupe. Le menu
    // contextuel propose déjà « Séparer les onglets » ; personne ne va le
    // chercher après avoir appris qu'on fusionne en glissant.
    if (pulledOut && this.registry.pair()?.includes(dragged)) {
      this.registry.unsplit();
    }
    if (index !== null) {
      this.registry.reorder(dragged, index);
    }
  }

  protected onTabPointerCancel(): void {
    this.stopDrag();
  }

  /**
   * Un segment d'onglet fusionné se traîne pour lui-même, afin qu'on puisse
   * en sortir UNE des deux sessions. Sans `stopPropagation`, le glissé de
   * l'onglet entier (posé sur le conteneur) partirait en même temps et c'est
   * la première session qui bougerait, quelle que soit celle qu'on tire.
   */
  protected onSegmentPointerDown(event: PointerEvent, id: string): void {
    event.stopPropagation();
    this.onTabPointerDown(event, id, true);
  }

  private stopDrag(): void {
    this.pending = null;
    this.draggingId.set(null);
    this.insertAt.set(null);
    this.mergeOnto.set(null);
    this.fromSegment = false;
    this.document.body.classList.remove('is-dock-dragging');
  }

  /**
   * Le rang sous le curseur, exprimé dans la liste des SESSIONS.
   *
   * Ce n'est pas le rang de l'onglet : un onglet fusionné vaut deux sessions,
   * et confondre les deux décale tout dès qu'une vue double est posée. Chaque
   * vignette porte donc l'identifiant de sa PREMIÈRE session, et c'est sa
   * position dans le registre qui fait foi.
   *
   * On compare au MILIEU de chaque onglet : la vignette pousse son voisin dès
   * qu'on l'a dépassé à moitié.
   */
  private indexAt(x: number): number {
    const sessions = this.registry.sessions();
    const tabs = Array.from(this.document.querySelectorAll<HTMLElement>('.bar [data-tab-first]'));
    for (const tab of tabs) {
      const rect = tab.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) {
        const at = sessions.findIndex((session) => session.id === tab.dataset['tabFirst']);
        return at === -1 ? sessions.length : at;
      }
    }
    return sessions.length;
  }

  /** Le trait se dessine-t-il devant cet onglet ? (rang de session, pas d'onglet) */
  protected insertBefore(tab: TabItem): boolean {
    const at = this.insertAt();
    if (at === null) {
      return false;
    }
    const first = tab.kind === 'single' ? tab.segment.id : tab.segments[0].id;
    return this.registry.sessions()[at]?.id === first;
  }

  /** Le trait se dessine-t-il en bout de barre ? */
  protected insertAtEnd(): boolean {
    return this.insertAt() === this.registry.sessions().length;
  }

  private readonly document = inject(DOCUMENT);

  constructor() {
    // Un onglet détruit en plein glissé (session fermée depuis une autre
    // surface) laisserait ses écouteurs et la main fermée sur toute l'app.
    this.destroyRef.onDestroy(() => this.stopDrag());
  }

  protected close(event: MouseEvent, id: string): void {
    // Le clic de fermeture ne doit pas aussi activer l'onglet.
    event.stopPropagation();
    void this.tabBar.closeSession(id);
  }

  /** Clic molette = fermer, comme dans un navigateur. */
  protected onAuxClick(event: MouseEvent, id: string): void {
    if (event.button === 1) {
      void this.tabBar.closeSession(id);
    }
  }

  /**
   * Clic droit sur un onglet simple : la vue double se pose ici, avec
   * n'importe quelle autre session embarquée : le focus du moment n'a pas
   * voix au chapitre. L'autre session passe à gauche (elle est déjà là),
   * celle qu'on vient de saisir à droite.
   */
  protected onTabMenu(event: MouseEvent, segment: TabSegment): void {
    const items = [];
    for (const other of this.tabBar.splitCandidatesFor(segment.id)) {
      items.push({
        label: this.t('misc.tabs.splitWith', { name: this.tabBar.displayTitleOf(other) }),
        icon: 'columns' as const,
        action: () => this.tabBar.split(other.id, segment.id),
      });
    }
    items.push({
      label: this.t('shortcuts.closeTab'),
      icon: 'close' as const,
      action: () => void this.tabBar.closeSession(segment.id),
    });
    this.contextMenu.open(event, items);
  }

  /** Clic droit sur un segment de l'onglet fusionné. */
  protected onSegmentMenu(event: MouseEvent, segment: TabSegment): void {
    this.contextMenu.open(event, [
      {
        label: this.t('misc.tabs.unsplit'),
        icon: 'columns',
        action: () => this.tabBar.unsplit(),
      },
      {
        label: this.t('shortcuts.closeTab'),
        icon: 'close',
        action: () => void this.tabBar.closeSession(segment.id),
      },
    ]);
  }
}
