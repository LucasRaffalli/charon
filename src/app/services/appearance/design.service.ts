import { Injectable, computed, inject, signal } from '@angular/core';

import { Accent, Appearance, DEFAULT_APPEARANCE, DockNode, Theme } from '@app/interfaces';
import { AppearanceService } from '@app/services/appearance/appearance.service';
import { DockLayout } from '@app/services/workspace/dock-tree';
import { DockService } from '@app/services/workspace/dock.service';
import { CustomTheme, CustomThemeService } from '@app/services/appearance/custom-theme.service';
import { ThemeService } from '@app/services/appearance/theme.service';
import { TranslationKey } from '@app/lang/i18n.service';

interface DesignSnapshot {
  theme: Theme;
  accent: Accent;
  appearance: Appearance;
  /** La disposition fait partie du brouillon : abandonner la rend aussi. */
  dock: DockNode;
  /** Le thème sur mesure aussi : l'atelier est un brouillon comme le reste. */
  custom: CustomTheme | null;
}

/** Taille d'une carte, quand l'utilisateur l'a redimensionnée. */
export interface PanelSize {
  width: number;
  height: number;
}

export interface PanelPosition {
  x: number;
  y: number;
}

/** Les deux panneaux flottants du mode design. */
export type DesignPanelId = 'base' | 'gradient' | 'atelier';

/** Un thème tout fait : le point de départ, pas une prison. */
export interface DesignTemplate {
  /** Clés de traduction : un préréglage est une constante de module, il ne
   *  peut pas lire la langue. Le panneau traduit à l'affichage. */
  label: TranslationKey;
  hint: TranslationKey;
  theme: Theme;
  accent: Accent;
  appearance: Appearance;
}

export const DESIGN_TEMPLATES: readonly DesignTemplate[] = [
  {
    label: 'themes.soberName',
    hint: 'themes.sober',
    theme: 'dark',
    accent: 'charon',
    appearance: { ...DEFAULT_APPEARANCE },
  },
  {
    label: 'themes.dayName',
    hint: 'themes.day',
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
    label: 'themes.auroraName',
    hint: 'themes.jade',
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
    label: 'themes.emberName',
    hint: 'themes.ember',
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
    label: 'themes.readableName',
    hint: 'themes.readable',
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
  private readonly customTheme = inject(CustomThemeService);

  private readonly _open = signal(false);
  private readonly _asking = signal(false);
  private readonly _snapshot = signal<DesignSnapshot | null>(null);
  private readonly _collapsed = signal<Record<DesignPanelId, boolean>>({
    base: false,
    gradient: false,
    atelier: false,
  });
  private readonly _positions = signal<Record<DesignPanelId, PanelPosition | null>>({
    base: null,
    gradient: null,
    atelier: null,
  });
  /** `null` = taille libre : la carte s'ajuste à son contenu, dans la limite
   *  que pose sa feuille. Une valeur = l'utilisateur a tiré la poignée. */
  private readonly _sizes = signal<Record<DesignPanelId, PanelSize | null>>({
    base: null,
    gradient: null,
    atelier: null,
  });
  readonly open = this._open.asReadonly();
  /** Vrai quand la modale « Enregistrer ce thème ? » est ouverte. */
  readonly asking = this._asking.asReadonly();
  readonly collapsed = this._collapsed.asReadonly();
  readonly positions = this._positions.asReadonly();
  readonly sizes = this._sizes.asReadonly();
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
      JSON.stringify(before.custom) !== JSON.stringify(this.customTheme.custom()) ||
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
      custom: this.customTheme.custom(),
    });
    this.theme.setPersisting(false);
    this.appearance.setPersisting(false);
    this.dock.setPersisting(false);
    this.customTheme.setPersisting(false);
    this._collapsed.set({ base: false, gradient: false, atelier: false });
    this._asking.set(false);
    this._open.set(true);
  }

  toggleCollapsed(id: DesignPanelId): void {
    const folding = !this._collapsed()[id];
    this._collapsed.update((current) => ({ ...current, [id]: !current[id] }));
    // Replier doit vraiment replier : une hauteur posée à la poignée
    // laisserait la carte à sa taille avec un corps vide en dessous. La
    // LARGEUR est conservée, elle reste pertinente une fois dépliée.
    if (folding) {
      this._sizes.update((current) => {
        const size = current[id];
        return size ? { ...current, [id]: { ...size, height: 0 } } : current;
      });
    }
  }

  moveTo(id: DesignPanelId, position: PanelPosition): void {
    this._positions.update((current) => ({ ...current, [id]: position }));
  }

  resizeTo(id: DesignPanelId, size: PanelSize): void {
    this._sizes.update((current) => ({ ...current, [id]: size }));
  }

  /** Une disposition toute faite. Réversible tant qu'on n'a pas tranché. */
  applyLayout(layout: DockLayout): void {
    this.dock.applyLayout(layout);
  }

  /** Un thème tout fait : thème, accent et apparence d'un coup. */
  applyTemplate(template: DesignTemplate): void {
    // Un préréglage EST un thème complet : le calque de l'atelier se retire,
    // sinon on choisirait « Aurore » pour se retrouver avec ses propres
    // couleurs par-dessus.
    this.customTheme.reset();
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
      this.customTheme.set(before.custom);
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
    this.customTheme.setPersisting(true);
    this._asking.set(false);
    this._open.set(false);
    this._snapshot.set(null);
  }
}
