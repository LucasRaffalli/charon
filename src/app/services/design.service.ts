import { Injectable, computed, inject, signal } from '@angular/core';

import { Accent, Appearance, DEFAULT_APPEARANCE, DockNode, Theme } from '@app/interfaces';
import { AppearanceService } from '@app/services/appearance.service';
import { DockLayout } from '@app/services/dock-tree';
import { DockService } from '@app/services/dock.service';
import { ThemeService } from '@app/services/theme.service';

interface DesignSnapshot {
  theme: Theme;
  accent: Accent;
  appearance: Appearance;
  /** La disposition fait partie du brouillon : abandonner la rend aussi. */
  dock: DockNode;
}

export interface PanelPosition {
  x: number;
  y: number;
}

/** Les deux panneaux flottants du mode design. */
export type DesignPanelId = 'base' | 'gradient';

/** Un thème tout fait : le point de départ, pas une prison. */
export interface DesignTemplate {
  label: string;
  hint: string;
  theme: Theme;
  accent: Accent;
  appearance: Appearance;
}

export const DESIGN_TEMPLATES: readonly DesignTemplate[] = [
  {
    label: 'Sobre',
    hint: 'Le Charon d\'origine, sans dégradé.',
    theme: 'dark',
    accent: 'charon',
    appearance: { ...DEFAULT_APPEARANCE },
  },
  {
    label: 'Clair de jour',
    hint: 'Fond clair, halo discret.',
    theme: 'light',
    accent: 'charon',
    appearance: {
      ...DEFAULT_APPEARANCE,
      gradient: 'halo',
      panels: 'translucide',
      intensity: 35,
    },
  },
  {
    label: 'Aurore',
    hint: 'Écharpe verte en travers.',
    theme: 'dark',
    accent: 'jade',
    appearance: {
      ...DEFAULT_APPEARANCE,
      gradient: 'aurore',
      panels: 'translucide',
      intensity: 78,
    },
  },
  {
    label: 'Braise',
    hint: 'Une montée de rouge depuis le bas.',
    theme: 'dark',
    accent: 'unloved',
    appearance: {
      ...DEFAULT_APPEARANCE,
      gradient: 'aube',
      panels: 'translucide',
      intensity: 78,
    },
  },
  {
    label: 'Lisible',
    hint: 'Contraste élevé, angles nets, texte grand.',
    theme: 'contrast',
    accent: 'charon',
    appearance: {
      ...DEFAULT_APPEARANCE,
      radius: 'net',
      text: 'grand',
    },
  },
];

/**
 * Le mode design : on règle l'apparence en voyant le résultat sur la vraie
 * interface, pas dans une modale qui la cache. Deux petits panneaux flottent
 * au-dessus, déplaçables et repliables : la vue garde sa taille réelle, la
 * seule à laquelle on puisse juger une interface de bureau, et ce qu'un
 * panneau cache se dégage en le poussant.
 *
 * C'est un brouillon, disposition du dock comprise. Tout s'applique
 * immédiatement pour qu'on voie, mais rien n'est enregistré tant qu'on n'a pas
 * confirmé : thème, apparence et dock cessent d'écrire dans le stockage
 * pendant la session, et n'y retournent qu'au moment de trancher, avec ce qui
 * est alors courant.
 */
@Injectable({ providedIn: 'root' })
export class DesignService {
  private readonly theme = inject(ThemeService);
  private readonly appearance = inject(AppearanceService);
  private readonly dock = inject(DockService);

  private readonly _open = signal(false);
  private readonly _asking = signal(false);
  private readonly _snapshot = signal<DesignSnapshot | null>(null);
  private readonly _collapsed = signal<Record<DesignPanelId, boolean>>({
    base: false,
    gradient: false,
  });
  private readonly _positions = signal<Record<DesignPanelId, PanelPosition | null>>({
    base: null,
    gradient: null,
  });
  readonly open = this._open.asReadonly();
  /** Vrai quand la modale « Enregistrer ce thème ? » est ouverte. */
  readonly asking = this._asking.asReadonly();
  readonly collapsed = this._collapsed.asReadonly();
  readonly positions = this._positions.asReadonly();
  readonly templates = DESIGN_TEMPLATES;

  /** Quelque chose a bougé depuis l'ouverture du mode design. */
  readonly dirty = computed(() => {
    const before = this._snapshot();
    if (!before) {
      return false;
    }
    return (
      before.theme !== this.theme.theme() ||
      before.accent !== this.theme.accent() ||
      JSON.stringify(before.appearance) !== JSON.stringify(this.appearance.appearance()) ||
      before.dock !== this.dock.tree()
    );
  });

  start(): void {
    if (this._open()) {
      return;
    }
    this._snapshot.set({
      theme: this.theme.theme(),
      accent: this.theme.accent(),
      appearance: this.appearance.appearance(),
      dock: this.dock.tree(),
    });
    this.theme.setPersisting(false);
    this.appearance.setPersisting(false);
    this.dock.setPersisting(false);
    this._collapsed.set({ base: false, gradient: false });
    this._asking.set(false);
    this._open.set(true);
  }

  toggleCollapsed(id: DesignPanelId): void {
    this._collapsed.update((current) => ({ ...current, [id]: !current[id] }));
  }

  moveTo(id: DesignPanelId, position: PanelPosition): void {
    this._positions.update((current) => ({ ...current, [id]: position }));
  }

  /** Une disposition toute faite. Réversible tant qu'on n'a pas tranché. */
  applyLayout(layout: DockLayout): void {
    this.dock.applyLayout(layout);
  }

  /** Un thème tout fait : thème, accent et apparence d'un coup. */
  applyTemplate(template: DesignTemplate): void {
    this.theme.select(template.theme);
    this.theme.selectAccent(template.accent);
    this.appearance.set({ ...template.appearance });
  }

  /** La croix : fermer sans avoir rien changé ne demande rien. */
  requestClose(): void {
    if (!this.dirty()) {
      this.finish();
      return;
    }
    this._asking.set(true);
  }

  /** « Terminé » et « Enregistrer » : le brouillon devient l'apparence courante. */
  save(): void {
    this.finish();
  }

  /** « Abandonner » : retour à l'état d'avant l'ouverture. */
  discard(): void {
    const before = this._snapshot();
    if (before) {
      this.theme.select(before.theme);
      this.theme.restoreAccent(before.accent);
      this.appearance.set(before.appearance);
      this.dock.restoreTree(before.dock);
    }
    this.finish();
  }

  /** « Continuer » : on referme la question et on garde la main. */
  keepEditing(): void {
    this._asking.set(false);
  }

  private finish(): void {
    // Rendre l'écriture avant de fermer : les effets repartent et posent dans
    // le stockage ce qui est courant, gardé ou restauré.
    this.theme.setPersisting(true);
    this.appearance.setPersisting(true);
    this.dock.setPersisting(true);
    this._asking.set(false);
    this._open.set(false);
    this._snapshot.set(null);
  }
}
